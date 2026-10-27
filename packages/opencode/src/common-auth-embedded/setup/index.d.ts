export { AMBIGUOUS_OPENCODE_MESSAGE, runSetup } from './command.js';
export { SetupCommandError, setupEnrollment } from './command-error.js';
export { detectHosts, detectOpenCodeGeneration, findExecutableOnPath, openCodeDesktopMarkers, } from './detect.js';
export { ENROLLMENT_WAIT_MS, HostNotEnrolledError, type HostNotEnrolledReason, UNSUPPORTED_VAULT_MESSAGE, } from './enroll.js';
export { setupUsage } from './flags.js';
export { assertHostsStopped, createProcessFence, listSetupProcesses, ProcessFenceViolationError, ProcessInspectionError, type ProcessInspectionStep, } from './process-fence.js';
export { type PlannedWrite, planOpenCodeRegistration, registerOpenCode, registerPi, updatePluginConfig, } from './register.js';
export type { CommandResult, CommandRunner, HostDetection, OpenCodeGeneration, ProcessFence, SetupCallbackContext, SetupDetection, SetupEnrollmentOutcome, SetupEnvironment, SetupFileSystem, SetupHost, SetupHostEnrollment, SetupIO, SetupPlugin, SetupResult, } from './types.js';
