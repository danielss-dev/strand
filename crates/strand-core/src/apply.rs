use crate::{error::Result, repo::Repo};

/// Where a patch should land. Picked by the UI when the user clicks a
/// per-hunk action in the Local Changes diff.
#[derive(Debug, Clone, Copy)]
pub enum ApplyTarget {
    /// Forward-apply to the index. "Stage hunk" — stage just that hunk.
    Index,
    /// Reverse-apply to the index. "Unstage hunk" — move that hunk back
    /// out of the index, leaving it in the working tree.
    IndexReverse,
    /// Reverse-apply to the working tree. "Discard hunk" — wipe that
    /// hunk from disk. Destructive; the UI is responsible for any undo
    /// affordance.
    WorkdirReverse,
    /// Forward-apply to the working tree. "Undo discard" — re-apply a
    /// previously discarded slice to disk. The exact inverse of
    /// [`WorkdirReverse`](ApplyTarget::WorkdirReverse) for the same patch,
    /// which is what powers the single-undo handle on discard.
    Workdir,
}

impl Repo {
    /// Apply a unified-diff patch to the index or the working tree. The
    /// patch must be the same shape `git diff` emits — `diff --git`
    /// header, `---`/`+++`, and one or more `@@` hunks. Callers slice
    /// per-hunk patches out of the per-file `FileDiff.patch` they
    /// already have. Reverse targets flip the patch via [`reverse_patch`]
    /// before applying.
    pub fn apply_patch(&self, patch: &str, target: ApplyTarget) -> Result<()> {
        let repo = self.git2()?;
        let (buf, location) = match target {
            ApplyTarget::Index => (patch.to_owned(), git2::ApplyLocation::Index),
            ApplyTarget::IndexReverse => (reverse_patch(patch), git2::ApplyLocation::Index),
            ApplyTarget::WorkdirReverse => (reverse_patch(patch), git2::ApplyLocation::WorkDir),
            ApplyTarget::Workdir => (patch.to_owned(), git2::ApplyLocation::WorkDir),
        };
        let diff = git2::Diff::from_buffer(buf.as_bytes())?;
        for delta in diff.deltas() {
            for file in [delta.old_file(), delta.new_file()] {
                if let Some(path) = file.path() {
                    if self.is_lfs_path(path)? {
                        return Err(crate::Error::Other("LFS files must be staged, unstaged or discarded as a whole file; partial patches would corrupt the pointer.".into()));
                    }
                }
            }
        }
        if self.sparse_enabled() {
            let mut args = vec!["apply", "--whitespace=nowarn"];
            if matches!(target, ApplyTarget::Index | ApplyTarget::IndexReverse) { args.push("--cached"); }
            if matches!(target, ApplyTarget::IndexReverse | ApplyTarget::WorkdirReverse) { args.push("--reverse"); }
            args.push("-");
            self.sparse_git(&args, Some(patch.as_bytes()))?;
            return Ok(());
        }
        repo.apply(&diff, location, None)?;
        Ok(())
    }
}

/// Produce the reverse of a unified patch. Mirrors `patch -R` semantics:
/// swap each hunk's `-A,B +C,D` line counts, flip `+`/`-` content lines,
/// and leave everything else — `diff --git`, `index`, `--- a/path`,
/// `+++ b/path`, context, `\ No newline at end of file` — unchanged. The
/// path headers stay put because the underlying file on disk doesn't move
/// when we reverse the change; git2 still needs to look it up by path.
///
/// Creation/deletion patches are the exception: leaving their headers put
/// would yield a contradiction (a "new file" patch whose hunks delete
/// lines), which git2 rejects with `ApplyFail`. For those the headers must
/// flip too — `new file mode` ↔ `deleted file mode`, the `/dev/null` side
/// of `---`/`+++` swaps ends, and the `index` oids swap so the preimage is
/// the side that actually exists.
fn reverse_patch(patch: &str) -> String {
    let mut out = String::with_capacity(patch.len());
    // Whether we're past a file's headers and into its `@@` hunks — content
    // lines there may start with `---`/`+++` too (a removed `-- foo` line)
    // and must take the single-char flip, not the header path.
    let mut in_hunks = false;
    // The `--- old` header is held until its `+++ new` partner so the pair
    // can be swapped when one side is /dev/null.
    let mut held_old: Option<(&str, &str)> = None;
    for line in patch.split_inclusive('\n') {
        let (body, nl) = match line.strip_suffix('\n') {
            Some(b) => (b, "\n"),
            None => (line, ""),
        };

        if body.starts_with("diff --git ") {
            in_hunks = false;
        }
        if body.starts_with("@@") {
            in_hunks = true;
            out.push_str(&reverse_hunk_header(body));
        } else if !in_hunks && body.starts_with("--- ") {
            // Hold until the `+++` partner; emitted there.
            held_old = Some((body, nl));
            continue;
        } else if !in_hunks && body.starts_with("+++ ") {
            let (old_body, old_nl) = held_old.take().unwrap_or(("--- /dev/null", "\n"));
            let old_path = old_body.strip_prefix("--- ").unwrap_or(old_body);
            let new_path = body.strip_prefix("+++ ").unwrap_or(body);
            if old_path == "/dev/null" {
                // Creation → deletion: the path moves to the old side.
                out.push_str("--- ");
                out.push_str(&swap_path_prefix(new_path, "b/", "a/"));
                out.push_str(old_nl);
                out.push_str("+++ /dev/null");
            } else if new_path == "/dev/null" {
                // Deletion → creation: the path moves to the new side.
                out.push_str("--- /dev/null");
                out.push_str(old_nl);
                out.push_str("+++ ");
                out.push_str(&swap_path_prefix(old_path, "a/", "b/"));
            } else {
                out.push_str(old_body);
                out.push_str(old_nl);
                out.push_str(body);
            }
        } else if !in_hunks && body.starts_with("new file mode ") {
            out.push_str("deleted file mode ");
            out.push_str(&body["new file mode ".len()..]);
        } else if !in_hunks && body.starts_with("deleted file mode ") {
            out.push_str("new file mode ");
            out.push_str(&body["deleted file mode ".len()..]);
        } else if !in_hunks && body.starts_with("index ") {
            out.push_str(&reverse_index_header(&body["index ".len()..]));
        } else if in_hunks && body.starts_with('+') {
            out.push('-');
            out.push_str(&body[1..]);
        } else if in_hunks && body.starts_with('-') {
            out.push('+');
            out.push_str(&body[1..]);
        } else {
            out.push_str(body);
        }
        out.push_str(nl);
    }
    out
}

/// `b/path` → `a/path` (and vice versa). Paths without the expected prefix
/// (e.g. emitted with `--no-prefix`) pass through unchanged.
fn swap_path_prefix(path: &str, from: &str, to: &str) -> String {
    match path.strip_prefix(from) {
        Some(rest) => format!("{to}{rest}"),
        None => path.to_owned(),
    }
}

/// Swap the oids in an `index <old>..<new>[ <mode>]` header, but only for
/// creation/deletion patches (one side all-zeros) — there the preimage oid
/// must name the side that exists or git2 refuses the apply. Modify patches
/// keep their header verbatim, matching the long-standing behavior.
fn reverse_index_header(rest: &str) -> String {
    let (ids, mode) = match rest.split_once(' ') {
        Some((ids, mode)) => (ids, Some(mode)),
        None => (rest, None),
    };
    if let Some((old, new)) = ids.split_once("..") {
        let is_zero = |s: &str| !s.is_empty() && s.chars().all(|c| c == '0');
        if is_zero(old) || is_zero(new) {
            return match mode {
                Some(m) => format!("index {new}..{old} {m}"),
                None => format!("index {new}..{old}"),
            };
        }
    }
    format!("index {rest}")
}

/// `@@ -A,B +C,D @@ heading` → `@@ -C,D +A,B @@ heading`. The trailing
/// "heading" (function context) is preserved verbatim.
fn reverse_hunk_header(line: &str) -> String {
    // Anatomy: "@@ -A[,B] +C[,D] @@[ heading]"
    let second_at = match line[2..].find("@@") {
        Some(p) => 2 + p,
        None => return line.to_owned(),
    };
    let ranges = &line[2..second_at]; // " -A,B +C,D "
    let tail = &line[second_at..]; // "@@ heading" or "@@"
    let mut minus = "";
    let mut plus = "";
    for tok in ranges.split_whitespace() {
        if let Some(r) = tok.strip_prefix('-') {
            minus = r;
        } else if let Some(r) = tok.strip_prefix('+') {
            plus = r;
        }
    }
    if minus.is_empty() || plus.is_empty() {
        return line.to_owned();
    }
    format!("@@ -{plus} +{minus} {tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverses_a_basic_hunk() {
        let patch = "\
diff --git a/foo.txt b/foo.txt
index 1111111..2222222 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,3 @@ fn x()
 one
-two
+TWO
 three
";
        let r = reverse_patch(patch);
        // Path headers stay put — `git apply -R` doesn't swap them.
        let want = "\
diff --git a/foo.txt b/foo.txt
index 1111111..2222222 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,3 @@ fn x()
 one
+two
-TWO
 three
";
        assert_eq!(r, want);
    }

    #[test]
    fn reverses_a_new_file_patch_into_a_deletion() {
        let patch = "\
diff --git a/n.txt b/n.txt
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/n.txt
@@ -0,0 +1,2 @@
+one
+two
";
        let want = "\
diff --git a/n.txt b/n.txt
deleted file mode 100644
index 2222222..0000000
--- a/n.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
";
        assert_eq!(reverse_patch(patch), want);
    }

    #[test]
    fn reverses_a_deletion_patch_into_a_creation() {
        let patch = "\
diff --git a/d.txt b/d.txt
deleted file mode 100644
index 2222222..0000000
--- a/d.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
";
        let want = "\
diff --git a/d.txt b/d.txt
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/d.txt
@@ -0,0 +1,2 @@
+one
+two
";
        assert_eq!(reverse_patch(patch), want);
    }

    #[test]
    fn content_lines_resembling_headers_still_flip() {
        // A removed line whose content starts with `--` renders as `---`;
        // inside a hunk it must take the +/- flip, not the header path.
        let patch = "\
diff --git a/x b/x
--- a/x
+++ b/x
@@ -1,2 +1,2 @@
--- not a header
+++ also not one
";
        let r = reverse_patch(patch);
        assert!(r.contains("\n+-- not a header\n"));
        assert!(r.contains("\n-++ also not one\n"));
        // The real headers above the hunk are untouched.
        assert!(r.contains("--- a/x\n+++ b/x\n"));
    }

    #[test]
    fn workdir_reverse_discards_an_untracked_file_and_workdir_restores_it() {
        // End to end: the patch comes from `diff_unstaged` exactly as the UI's
        // per-hunk discard does, so this covers the git2 apply step too.
        let dir = std::env::temp_dir().join(format!(
            "strand-apply-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = git2::Repository::init(&dir).unwrap();
        {
            let mut cfg = git.config().unwrap();
            cfg.set_str("user.name", "Test").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let tree_oid = git.index().unwrap().write_tree().unwrap();
        let tree = git.find_tree(tree_oid).unwrap();
        git.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        let repo = Repo::discover(dir.to_str().unwrap()).unwrap();

        std::fs::write(dir.join("fresh.txt"), "one\ntwo\n").unwrap();
        let diffs = repo.diff_unstaged().unwrap();
        let patch = diffs.iter().find(|d| d.path == "fresh.txt").unwrap().patch.clone();

        // Discard: the reversed creation deletes the file from disk.
        repo.apply_patch(&patch, ApplyTarget::WorkdirReverse).unwrap();
        assert!(!dir.join("fresh.txt").exists(), "discard removed the untracked file");

        // Undo: forward-applying the same slice brings it back (modulo the
        // platform's autocrlf checkout filter).
        repo.apply_patch(&patch, ApplyTarget::Workdir).unwrap();
        let restored = std::fs::read_to_string(dir.join("fresh.txt")).unwrap();
        assert_eq!(restored.replace("\r\n", "\n"), "one\ntwo\n");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn handles_unchanged_counts_and_no_newline_marker() {
        let patch = "\
diff --git a/x b/x
--- a/x
+++ b/x
@@ -1 +1,2 @@
-only
+ONLY
+added
\\ No newline at end of file
";
        let r = reverse_patch(patch);
        assert!(r.contains("--- a/x"));
        assert!(r.contains("+++ b/x"));
        assert!(r.contains("@@ -1,2 +1 @@"));
        assert!(r.contains("+only"));
        assert!(r.contains("-ONLY"));
        assert!(r.contains("-added"));
        assert!(r.contains("\\ No newline at end of file"));
    }
}
