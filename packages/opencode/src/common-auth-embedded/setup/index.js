export { AMBIGUOUS_OPENCODE_MESSAGE, runSetup } from './command.js';
export { SetupCommandError, setupEnrollment } from './command-error.js';
export { detectHosts, detectOpenCodeGeneration, findExecutableOnPath, openCodeDesktopMarkers, } from './detect.js';
export { ENROLLMENT_WAIT_MS, HostNotEnrolledError, UNSUPPORTED_VAULT_MESSAGE, } from './enroll.js';
export { assertHostsStopped, createProcessFence, listSetupProcesses, ProcessFenceViolationError, ProcessInspectionError, } from './process-fence.js';
export { planOpenCodeRegistration, registerOpenCode, registerPi, updatePluginConfig, } from './register.js';
