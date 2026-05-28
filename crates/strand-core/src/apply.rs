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
fn reverse_patch(patch: &str) -> String {
    let mut out = String::with_capacity(patch.len());
    for line in patch.split_inclusive('\n') {
        let (body, nl) = match line.strip_suffix('\n') {
            Some(b) => (b, "\n"),
            None => (line, ""),
        };

        // Order matters: `---`/`+++` path headers must be caught before
        // the single-char `+`/`-` content-line swap, or we'd corrupt them.
        if body.starts_with("--- ") || body.starts_with("+++ ") {
            out.push_str(body);
        } else if body.starts_with("@@") {
            out.push_str(&reverse_hunk_header(body));
        } else if let Some(rest) = body.strip_prefix('+') {
            out.push('-');
            out.push_str(rest);
        } else if let Some(rest) = body.strip_prefix('-') {
            out.push('+');
            out.push_str(rest);
        } else {
            out.push_str(body);
        }
        out.push_str(nl);
    }
    out
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
