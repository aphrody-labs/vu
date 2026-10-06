# SPDX-License-Identifier: Apache-2.0
"""`vu hf`: native Hugging Face configuration and hub-layout downloads, standard library only.

Run by the embedded CPython of the runtime (`vu hf ...`). The cache layout is the one of `huggingface_hub`
(`models--org--name/{blobs,snapshots,refs}`), so what vu downloads is found by `transformers`, vLLM and friends, and the
reverse. The token is read from HF_TOKEN, HUGGING_FACE_HUB_TOKEN, HF_TOKEN_PATH or `<HF_HOME>/token`, is only sent as a
Bearer header to the configured endpoint and is never printed.

    vu hf status [--json]
    vu hf download <org/name> <file> [--revision R] [--type model|dataset|space]
    vu hf path <org/name> [--type ...]       # cache folder of a repository
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO_RE = re.compile(r"^[\w.-]+(/[\w.-]+)?$")


def filled(value):
    return value if value else None


def hf_home(env, home):
    explicit = filled(env.get("HF_HOME"))
    if explicit:
        return os.path.abspath(explicit)
    xdg = filled(env.get("XDG_CACHE_HOME"))
    return os.path.join(xdg or os.path.join(home, ".cache"), "huggingface")


def read_token(env, home):
    direct = filled(env.get("HF_TOKEN")) or filled(env.get("HUGGING_FACE_HUB_TOKEN"))
    if direct:
        return direct.strip(), "HF_TOKEN"
    candidates = []
    path = filled(env.get("HF_TOKEN_PATH"))
    if path:
        candidates.append((os.path.abspath(path), "HF_TOKEN_PATH"))
    candidates.append((os.path.join(hf_home(env, home), "token"), "file"))
    for file, source in candidates:
        if os.path.isfile(file):
            with open(file, encoding="utf-8") as handle:
                value = handle.read().strip()
            if value:
                return value, source
    return None


def resolve(env=None, home=None):
    env = os.environ if env is None else env
    home = home or os.path.expanduser("~")
    base = hf_home(env, home)
    token = read_token(env, home)
    hub = filled(env.get("HF_HUB_CACHE")) or filled(env.get("HUGGINGFACE_HUB_CACHE")) or os.path.join(base, "hub")
    return {
        "home": base,
        "hubCache": os.path.abspath(hub),
        "endpoint": (filled(env.get("HF_ENDPOINT")) or "https://huggingface.co").rstrip("/"),
        "offline": env.get("HF_HUB_OFFLINE") == "1",
        "token": {"present": token is not None, "source": token[1] if token else None},
    }


def repo_folder(repo, kind="model"):
    if not REPO_RE.match(repo):
        raise ValueError("invalid repository id: %s" % repo)
    return "%ss--%s" % (kind, repo.replace("/", "--"))


def download_file(repo, file, revision="main", kind="model", env=None, home=None, opener=None):
    env = os.environ if env is None else env
    home = home or os.path.expanduser("~")
    config = resolve(env, home)
    folder = os.path.join(config["hubCache"], repo_folder(repo, kind))
    ref = os.path.join(folder, "refs", revision)
    if not re.match(r"^[0-9a-f]{40}$", revision) and os.path.isfile(ref):
        with open(ref, encoding="utf-8") as handle:
            commit = handle.read().strip()
        known = os.path.join(folder, "snapshots", commit, file)
        if os.path.exists(known):
            return {"path": known, "commit": commit, "cached": True}
    if config["offline"]:
        raise RuntimeError("%s/%s is not cached and HF_HUB_OFFLINE=1" % (repo, file))
    token = read_token(env, home)
    quoted = "/".join(urllib.parse.quote(part) for part in file.split("/"))
    prefix = "" if kind == "model" else kind + "s/"
    url = "%s/%s%s/resolve/%s/%s" % (config["endpoint"], prefix, repo, urllib.parse.quote(revision, safe=""), quoted)
    request = urllib.request.Request(url)
    if token:
        request.add_header("Authorization", "Bearer " + token[0])
    with (opener or urllib.request.urlopen)(request) as response:
        headers = response.headers
        commit = headers.get("x-repo-commit") or (revision if re.match(r"^[0-9a-f]{40}$", revision) else None)
        etag = (headers.get("x-linked-etag") or headers.get("etag") or "").replace('"', "")
        etag = re.sub(r"^W/", "", etag)
        if not commit or not re.match(r"^[\w-]+$", etag):
            raise RuntimeError("%s: the response lacks x-repo-commit or an etag" % url)
        blob = os.path.join(folder, "blobs", etag)
        os.makedirs(os.path.dirname(blob), exist_ok=True)
        partial = blob + ".incomplete"
        with open(partial, "wb") as out:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
    os.replace(partial, blob)
    link = os.path.join(folder, "snapshots", commit, file)
    os.makedirs(os.path.dirname(link), exist_ok=True)
    if os.path.lexists(link):
        os.remove(link)
    os.symlink(os.path.relpath(blob, os.path.dirname(link)), link)
    os.makedirs(os.path.dirname(ref), exist_ok=True)
    with open(ref, "w", encoding="utf-8") as handle:
        handle.write(commit)
    return {"path": link, "commit": commit, "cached": False}


def option(args, name, default=None):
    if name in args:
        at = args.index(name)
        if at + 1 < len(args):
            value = args[at + 1]
            del args[at : at + 2]
            return value
    return default


def main(argv):
    args = list(argv)
    command = args.pop(0) if args else "status"
    if command == "status":
        report = resolve()
        if "--json" in args:
            print(json.dumps(report, indent=2))
        else:
            token = report["token"]
            print("HF_HOME        %s" % report["home"])
            print("hub cache      %s" % report["hubCache"])
            print("endpoint       %s" % report["endpoint"])
            print("offline        %s" % ("yes" if report["offline"] else "no"))
            print("token          %s" % ("present (%s)" % token["source"] if token["present"] else "absent"))
        return 0
    if command == "download":
        revision = option(args, "--revision", "main")
        kind = option(args, "--type", "model")
        if len(args) != 2:
            print("usage: vu hf download <org/name> <file> [--revision R] [--type model|dataset|space]", file=sys.stderr)
            return 64
        try:
            print(json.dumps(download_file(args[0], args[1], revision, kind)))
        except (urllib.error.URLError, RuntimeError, ValueError, OSError) as error:
            print("vu hf: %s" % error, file=sys.stderr)
            return 1
        return 0
    if command == "path":
        kind = option(args, "--type", "model")
        if len(args) != 1:
            print("usage: vu hf path <org/name> [--type model|dataset|space]", file=sys.stderr)
            return 64
        print(os.path.join(resolve()["hubCache"], repo_folder(args[0], kind)))
        return 0
    print("usage: vu hf status|download|path", file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
