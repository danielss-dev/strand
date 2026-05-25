import { create } from 'zustand';
import { recents as recentsDb, settings as settingsDb } from '../lib/db';
import { tauri } from '../lib/tauri';
const SESSION_KEY = 'session.tabs';
const EMPTY_ACTIVE = {
    activePath: null,
    meta: null,
    status: [],
    commits: [],
    unstagedDiffs: [],
    stagedDiffs: [],
    localSelection: null,
    selectedFile: null,
};
async function persistSession(state) {
    try {
        const payload = {
            tabs: state.tabs.map((t) => t.path),
            activeTabPath: state.activeTabPath,
        };
        await settingsDb.set(SESSION_KEY, payload);
    }
    catch (e) {
        console.warn('session persist failed', e);
    }
}
export const useRepo = create((set, get) => ({
    tabs: [],
    activeTabPath: null,
    ...EMPTY_ACTIVE,
    recents: [],
    view: 'local',
    selectedRef: null,
    async restoreSession() {
        let saved = null;
        try {
            saved = await settingsDb.get(SESSION_KEY);
        }
        catch (e) {
            console.warn('session load failed', e);
        }
        if (!saved || saved.tabs.length === 0)
            return;
        // Open each saved tab; openRepo handles dedupe and tolerates failures
        // (a repo may have moved or been deleted since last launch).
        for (const path of saved.tabs) {
            try {
                await get().openRepo(path);
            }
            catch (e) {
                console.warn(`restoreSession: failed to open ${path}`, e);
            }
        }
        if (saved.activeTabPath) {
            const stillOpen = get().tabs.some((t) => t.path === saved.activeTabPath);
            if (stillOpen && get().activeTabPath !== saved.activeTabPath) {
                await get().setActiveTab(saved.activeTabPath);
            }
        }
    },
    async openRepo(path) {
        // If this path is already open, just focus it.
        const existing = get().tabs.find((t) => t.path === path);
        if (existing) {
            await get().setActiveTab(existing.path);
            return;
        }
        const meta = await tauri.repoOpen(path);
        // Rust may canonicalize the path; re-check against the canonical form.
        const already = get().tabs.find((t) => t.path === meta.path);
        if (already) {
            await get().setActiveTab(already.path);
            return;
        }
        const tab = { path: meta.path, meta };
        set((s) => ({
            tabs: [...s.tabs, tab],
            activeTabPath: meta.path,
            activePath: meta.path,
            meta,
            status: [],
            commits: [],
            unstagedDiffs: [],
            stagedDiffs: [],
            localSelection: null,
            selectedFile: null,
        }));
        try {
            await recentsDb.touch(meta.path, meta.name);
            await get().refreshRecents();
        }
        catch (e) {
            console.warn('recents.touch failed', e);
        }
        void persistSession(get());
        await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
    },
    closeTab(path) {
        const { tabs, activeTabPath } = get();
        const idx = tabs.findIndex((t) => t.path === path);
        if (idx === -1)
            return;
        const nextTabs = tabs.filter((t) => t.path !== path);
        if (activeTabPath !== path) {
            set({ tabs: nextTabs });
            void persistSession(get());
            return;
        }
        // Closed the active tab — pick a neighbor, or fall back to empty state.
        const neighbor = nextTabs[idx] ?? nextTabs[idx - 1] ?? null;
        set({
            tabs: nextTabs,
            activeTabPath: neighbor?.path ?? null,
            activePath: neighbor?.path ?? null,
            meta: neighbor?.meta ?? null,
            status: [],
            commits: [],
            unstagedDiffs: [],
            stagedDiffs: [],
            localSelection: null,
            selectedFile: null,
        });
        void persistSession(get());
        if (neighbor) {
            void Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
        }
    },
    async setActiveTab(path) {
        const tab = get().tabs.find((t) => t.path === path);
        if (!tab || get().activeTabPath === path)
            return;
        set({
            activeTabPath: path,
            activePath: path,
            meta: tab.meta,
            status: [],
            commits: [],
            unstagedDiffs: [],
            stagedDiffs: [],
            localSelection: null,
            selectedFile: null,
        });
        void persistSession(get());
        await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
    },
    async refreshStatus() {
        const path = get().activePath;
        if (!path)
            return;
        set({ status: await tauri.repoStatus(path) });
    },
    async refreshLog(limit) {
        const path = get().activePath;
        if (!path)
            return;
        set({ commits: await tauri.repoLog(path, limit ?? 500) });
    },
    async refreshDiffs() {
        const path = get().activePath;
        if (!path)
            return;
        const [unstaged, staged] = await Promise.all([
            tauri.repoDiffUnstaged(path),
            tauri.repoDiffStaged(path),
        ]);
        set({ unstagedDiffs: unstaged, stagedDiffs: staged });
        // If the selected file is no longer present (it was just staged in full,
        // for example) move the selection to a sibling so the middle pane keeps
        // showing something useful.
        const sel = get().localSelection;
        if (sel) {
            const stillThere = (sel.staged ? staged : unstaged).some((f) => f.path === sel.file);
            if (!stillThere) {
                const alt = (sel.staged ? unstaged : staged).find((f) => f.path === sel.file);
                set({ localSelection: alt ? { file: alt.path, staged: !sel.staged } : null });
            }
        }
    },
    async refreshLocalChanges() {
        await Promise.all([get().refreshStatus(), get().refreshDiffs()]);
    },
    async stage(file) {
        const path = get().activePath;
        if (!path)
            return;
        await tauri.repoStage(path, file);
        await get().refreshLocalChanges();
    },
    async unstage(file) {
        const path = get().activePath;
        if (!path)
            return;
        await tauri.repoUnstage(path, file);
        await get().refreshLocalChanges();
    },
    async discard(file) {
        const path = get().activePath;
        if (!path)
            return;
        await tauri.repoDiscard(path, file);
        await get().refreshLocalChanges();
    },
    async stageAll() {
        const path = get().activePath;
        if (!path)
            return;
        const files = get().unstagedDiffs.map((d) => d.path);
        for (const f of files)
            await tauri.repoStage(path, f);
        await get().refreshLocalChanges();
    },
    async unstageAll() {
        const path = get().activePath;
        if (!path)
            return;
        const files = get().stagedDiffs.map((d) => d.path);
        for (const f of files)
            await tauri.repoUnstage(path, f);
        await get().refreshLocalChanges();
    },
    async commit(subject, body, amend) {
        const path = get().activePath;
        if (!path)
            return;
        await tauri.repoCommit(path, subject, body, amend);
        await Promise.all([get().refreshLocalChanges(), get().refreshLog(), get().refreshMeta()]);
    },
    async refreshMeta() {
        const path = get().activePath;
        if (!path)
            return;
        const meta = await tauri.repoMeta(path);
        set((s) => ({
            meta,
            tabs: s.tabs.map((t) => (t.path === path ? { ...t, meta } : t)),
        }));
    },
    async fetch() {
        const path = get().activePath;
        if (!path)
            throw new Error('no repo open');
        const res = await tauri.repoFetch(path, null);
        await get().refreshMeta();
        return res.output;
    },
    async pull(rebase = false) {
        const path = get().activePath;
        if (!path)
            throw new Error('no repo open');
        const res = await tauri.repoPull(path, rebase);
        await Promise.all([get().refreshMeta(), get().refreshLocalChanges(), get().refreshLog()]);
        return res.output;
    },
    async push(forceWithLease = false) {
        const path = get().activePath;
        if (!path)
            throw new Error('no repo open');
        const res = await tauri.repoPush(path, forceWithLease);
        await get().refreshMeta();
        return res.output;
    },
    selectLocalFile: (sel) => set({ localSelection: sel }),
    async refreshRecents() {
        try {
            set({ recents: await recentsDb.list() });
        }
        catch (e) {
            console.warn('recents.list failed', e);
        }
    },
    async forgetRecent(path) {
        await recentsDb.forget(path);
        await get().refreshRecents();
    },
    setView: (view) => set({ view }),
    selectFile: (selectedFile) => set({ selectedFile, view: selectedFile ? 'file' : get().view }),
    selectRef: (selectedRef) => set({ selectedRef }),
}));
