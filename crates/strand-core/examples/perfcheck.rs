//! Performance baseline harness for the strand-core read path (PRD §8).
//!
//! Not a product feature — a dev tool to measure the engine's hot reads
//! against large repos before the performance pass touches them, so a change
//! can be checked against a real number instead of merged blind (the prime
//! directive forbids regressing a hot path).
//!
//! Usage:
//!   cargo run --release --example perfcheck -- <repo-path> [log-limit]
//!
//! It times each public read op the IPC layer calls, reporting min/median/max
//! over N iterations on a warm handle, plus the cost of `discover` alone and a
//! combined `discover + log` (what every IPC command actually pays today,
//! since commands re-discover per call).

use std::time::{Duration, Instant};

use strand_core::Repo;

fn bench<T>(name: &str, iters: usize, mut f: impl FnMut() -> T) {
    // One warmup pass (page caches, lazy git2 internals) excluded from stats.
    let _ = f();
    let mut times = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t = Instant::now();
        let _ = std::hint::black_box(f());
        times.push(t.elapsed());
    }
    times.sort_unstable();
    let min = times[0];
    let med = times[iters / 2];
    let max = times[iters - 1];
    println!(
        "  {name:<26} min {:>9}  med {:>9}  max {:>9}   (n={iters})",
        ms(min),
        ms(med),
        ms(max)
    );
}

fn ms(d: Duration) -> String {
    format!("{:.2}ms", d.as_secs_f64() * 1000.0)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| ".".to_string());
    let log_limit: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(5000);

    println!("\n== strand-core perfcheck ==");
    println!("repo: {path}");

    // --- Open / discover (cold per-command cost) ---
    bench("discover (open)", 30, || {
        Repo::discover(&path).expect("discover")
    });

    let repo = Repo::discover(&path).expect("discover");

    // The other half of the per-command open cost: the git2 handle most ops
    // open on top of the gix discover.
    bench("git2 open", 30, || {
        git2::Repository::open(repo.path()).expect("git2 open")
    });

    // --- meta (every post-op refresh) ---
    bench("meta", 50, || repo.meta().expect("meta"));

    // --- snapshot (the bundled post-change refresh the app actually calls) ---
    bench("snapshot", 20, || repo.snapshot().expect("snapshot"));
    bench("discover+snapshot", 20, || {
        Repo::discover(&path).expect("discover").snapshot().expect("snapshot")
    });

    // --- log at several limits (graph load) ---
    for limit in [1000usize, 10_000, log_limit] {
        // De-dup if log_limit collides with a fixed limit.
        bench(&format!("log({limit})"), 10, || {
            repo.log(limit).expect("log")
        });
    }

    // Full IPC round-trip the app actually pays today: re-discover + log.
    bench("discover+log(5000)", 10, || {
        Repo::discover(&path).expect("discover").log(5000).expect("log")
    });

    // --- Standalone status + tree reads (snapshot shares their walk) ---
    bench("status", 30, || repo.status().expect("status"));
    bench("work_tree", 30, || repo.work_tree().expect("work_tree"));
    bench("work_tree+ignored roots", 30, || {
        repo.work_tree_with_ignored(true)
            .expect("work_tree ignored roots")
    });

    // --- diffs (Local Changes) ---
    bench("diff_unstaged_paths", 20, || {
        repo.diff_unstaged_paths().expect("diff_unstaged_paths")
    });
    bench("diff_unstaged", 20, || {
        repo.diff_unstaged().expect("diff_unstaged")
    });
    bench("diff_staged", 20, || {
        repo.diff_staged().expect("diff_staged")
    });

    // Whole-file Review payloads and Worktrees' advisory scan are separate
    // from status and viewport rendering; measure them rather than inferring
    // their cost from the cheap snapshot or the number of mounted rows.
    bench("diff_since_full(HEAD)", 5, || {
        Repo::discover(&path)
            .expect("discover")
            .diff_since_full("HEAD")
            .expect("diff_since_full")
    });
    bench("discover+worktree_stats", 5, || {
        Repo::discover(&path)
            .expect("discover")
            .worktree_stats()
            .expect("worktree_stats")
    });
    for (label, diffs) in [
        ("unstaged", repo.diff_unstaged().expect("diff_unstaged")),
        ("review", repo.diff_since_full("HEAD").expect("diff_since_full")),
    ] {
        println!(
            "  {label} payload: {} files, {} patch bytes, {} JSON bytes",
            diffs.len(),
            diffs.iter().map(|diff| diff.patch.len()).sum::<usize>(),
            serde_json::to_vec(&diffs).expect("serialize diffs").len(),
        );
    }

    println!();
}
