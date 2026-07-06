"""Regenerate the strand perf fixtures (docs/perf-baseline.md spec).

- bighist:  100,000 commits, 50-file churning tree, linear history (fast-import)
- bigtree:  10,001 tracked files in nested dirs + one 5,000-line file;
            working tree dirtied to 501 changed paths

Usage: python scripts/gen_perf_fixtures.py [output-dir]
Default output dir: ~/GitSources/.strand-perf-fixtures (outside any repo).
"""

import os
import shutil
import subprocess
import sys
import time

ROOT = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.path.expanduser(os.path.join("~", "GitSources", ".strand-perf-fixtures"))
)


def run(args, cwd=None, **kw):
    subprocess.run(args, cwd=cwd, check=True, **kw)


def init_repo(path):
    if os.path.exists(path):
        shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path)
    run(["git", "init", "-q", "-b", "main", path])
    run(["git", "-C", path, "config", "user.name", "Perf Fixture"])
    run(["git", "-C", path, "config", "user.email", "perf@example.com"])
    run(["git", "-C", path, "config", "core.autocrlf", "false"])
    run(["git", "-C", path, "config", "gc.auto", "0"])


def gen_bighist():
    path = os.path.join(ROOT, "bighist")
    init_repo(path)
    n_commits = 100_000
    n_files = 50
    t0 = time.time()
    p = subprocess.Popen(
        ["git", "-C", path, "fast-import", "--quiet"],
        stdin=subprocess.PIPE,
    )
    w = p.stdin
    base_ts = 1_600_000_000
    for i in range(n_commits):
        blob = f"content of revision {i}\nline two {i * 7}\n".encode()
        w.write(b"blob\nmark :%d\ndata %d\n" % (i + 1, len(blob)))
        w.write(blob)
        w.write(b"\n")
        ts = base_ts + i * 60
        msg = f"commit {i}: churn file {i % n_files}\n\nbody line for {i}\n".encode()
        w.write(b"commit refs/heads/main\n")
        w.write(b"mark :%d\n" % (n_commits + i + 1))
        w.write(
            b"author Perf Fixture <perf@example.com> %d +0000\n"
            b"committer Perf Fixture <perf@example.com> %d +0000\n" % (ts, ts)
        )
        w.write(b"data %d\n" % len(msg))
        w.write(msg)
        if i > 0:
            w.write(b"from :%d\n" % (n_commits + i))
        w.write(b"M 100644 :%d file%02d.txt\n" % (i + 1, i % n_files))
        w.write(b"\n")
    w.write(b"done\n")
    w.close()
    if p.wait() != 0:
        sys.exit("fast-import failed")
    run(["git", "-C", path, "checkout", "-q", "main"])
    run(["git", "-C", path, "commit-graph", "write", "--reachable"])
    print(f"bighist: {n_commits} commits in {time.time() - t0:.1f}s")


def gen_bigtree():
    path = os.path.join(ROOT, "bigtree")
    init_repo(path)
    t0 = time.time()
    n = 0
    for d1 in range(10):
        for d2 in range(10):
            d = os.path.join(path, f"dir{d1:02d}", f"sub{d2:02d}")
            os.makedirs(d)
            for f in range(100):
                with open(os.path.join(d, f"file{f:03d}.txt"), "w", newline="\n") as fh:
                    fh.write(f"file {d1}/{d2}/{f}\ncontent line\n")
                n += 1
    with open(os.path.join(path, "big5000.txt"), "w", newline="\n") as fh:
        fh.writelines(f"line {i} of the big file\n" for i in range(5000))
    n += 1
    run(["git", "-C", path, "add", "-A"])
    run(["git", "-C", path, "commit", "-q", "-m", "seed 10k tree"])
    # Dirty 501 paths: modify 500 tracked + rewrite 500 lines of the big file.
    dirtied = 0
    for d1 in range(5):
        for d2 in range(10):
            for f in range(10):
                fp = os.path.join(path, f"dir{d1:02d}", f"sub{d2:02d}", f"file{f:03d}.txt")
                with open(fp, "a", newline="\n") as fh:
                    fh.write("dirty edit\n")
                dirtied += 1
    with open(os.path.join(path, "big5000.txt"), "w", newline="\n") as fh:
        fh.writelines(
            (f"line {i} EDITED\n" if i % 10 == 0 else f"line {i} of the big file\n")
            for i in range(5000)
        )
    dirtied += 1
    print(f"bigtree: {n} files, {dirtied} dirtied in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    gen_bighist()
    gen_bigtree()
    print("done:", ROOT)
