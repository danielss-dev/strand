//! Owned Windows process jobs shared by Git and desktop command runners.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::process::{Child, Command};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct WindowsJob(OwnedHandle);

impl WindowsJob {
    pub fn assign(child: &Child) -> Result<Self, String> {
        // SAFETY: null arguments request an unnamed job with default security;
        // ownership transfers to OwnedHandle only after checking the result.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() { return Err(last_error("create cancellation job")); }
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        // Use the child's owned handle rather than reopening a numeric PID.
        if unsafe { AssignProcessToJobObject(job.0.as_raw_handle(), child.as_raw_handle()) } == 0 {
            return Err(last_error("assign process to cancellation job"));
        }
        Ok(job)
    }

    pub fn kill_on_close(&self) -> Result<(), String> {
        // SAFETY: initialized structure, live job handle, and matching size.
        unsafe {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(self.0.as_raw_handle(), JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32) == 0 {
                return Err(last_error("configure cancellation job cleanup"));
            }
        }
        Ok(())
    }

    pub fn terminate(&self) {
        // SAFETY: the owned handle remains valid even after the leader exits.
        unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) };
    }

    /// Assign before any user code runs, so even a fast Git wrapper cannot
    /// spawn helpers outside the job or exit before job assignment.
    pub(crate) fn spawn(command: &mut Command) -> Result<(Child, Self), String> {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        let mut child = command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
            .spawn().map_err(|error| format!("spawn git failed: {error}"))?;
        let setup = Self::assign(&child).and_then(|job| {
            job.kill_on_close()?;
            resume_primary_thread(&child)?;
            Ok(job)
        });
        match setup {
            Ok(job) => Ok((child, job)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(error)
            }
        }
    }
}

fn last_error(action: &str) -> String {
    format!("Could not {action}: {}", std::io::Error::last_os_error())
}

fn resume_primary_thread(child: &Child) -> Result<(), String> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    // Stable std does not expose Child's primary thread handle. The suspended
    // process has not executed user code; enumerate its initial thread while
    // the owned process handle keeps its identity alive.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE { return Err(last_error("enumerate suspended Git thread")); }
        let snapshot = OwnedHandle::from_raw_handle(snapshot);
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut found = Thread32First(snapshot.as_raw_handle(), &mut entry);
        while found != 0 {
            if entry.th32OwnerProcessID == child.id() {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if thread.is_null() { return Err(last_error("open suspended Git thread")); }
                let thread = OwnedHandle::from_raw_handle(thread);
                if ResumeThread(thread.as_raw_handle()) == u32::MAX {
                    return Err(last_error("resume Git thread"));
                }
                return Ok(());
            }
            found = Thread32Next(snapshot.as_raw_handle(), &mut entry);
        }
    }
    Err("Could not find suspended Git thread".into())
}
