// These suites assert crash recovery, durable publication, lock fencing, or
// filesystem permissions. tmpfs cannot serve as their real-disk reference,
// even when a MOTOR job opts the other tests into its private /dev/shm mount.
// Keep reasons here, and add new filesystem-sensitive suites conservatively.
export const DISK_TEST_FILES: Readonly<Record<string, string>> = {
  'packages/core/src/file-lock.test.ts':
    'Fenced lock ownership, eviction, renewal, and concurrent writers.',
  'packages/core/src/atomic-write.test.ts':
    'Atomic replacement and secure file permissions.',
  'packages/core/src/account-storage.test.ts':
    'Lock-held mutations, concurrent writers, replacement, and mode tightening.',
  'packages/core/src/account-repository.test.ts':
    'Interrupted account replacement recovery with and without transfer files.',
  'packages/core/src/account-repository-publication.test.ts':
    'Child-process exits at publication seams followed by store replay and cleanup.',
  'packages/core/src/account-migration-temp-recovery.test.ts':
    'Recovery adapter requires file and directory sync capabilities.',
  'packages/core/src/account-relocation.test.ts':
    'Moved-store fixtures on real store locks with private modes (0600/0700); released-core child against the same files.',
  'packages/core/src/common-auth-runtime.test.ts':
    'Real embedded atomic file writes and owned filesystem locks.',
  'packages/core/src/vault-provider-state.test.ts':
    'Real roster/state locks and refusal to publish after lock loss before rename.',
  'packages/core/src/vault-folder-refusal.test.ts':
    'POSIX group-writable and sticky-directory permission refusals.',
  'packages/core/src/vault-account-source.test.ts':
    'Conservative: lock adapter and private-mode enrollment-token fixtures.',
  'packages/core/src/vault-enrollment-authority.test.ts':
    'Conservative: private-mode enrollment-token corruption and restoration fixtures.',
  'packages/core/src/__fixtures__/legacy-writer.test.ts':
    'Historical atomic writer and lock closure exercised by recovery suites.',
  'packages/core/src/__fixtures__/common-auth-public-consumer.test.ts':
    'Conservative: owned private-mode package and dependency staging fixtures.',
  'packages/core/src/__fixtures__/common-auth-public-consumer-admission.test.ts':
    'Admission verifies the historical atomic writer and lock closure before execution.',
  'packages/opencode/src/tui/file-logger.test.ts':
    'Log rotation and file/parent permission tightening.',
  'packages/opencode/src/rpc/port-file.test.ts':
    'Atomic port-file publication, secure modes, and stale-entry cleanup.',
  'packages/opencode/src/sidebar-state.test.ts':
    'Lock contention, takeover between merge and rename, and private modes.',
  'packages/opencode/src/plugin/config/writer.test.ts':
    'Atomic fenced-lock config writes and failed-write temporary-file cleanup.',
  'packages/opencode/src/plugin/operator-settings.test.ts':
    'Settings persistence through the lock-held writer.',
  'packages/opencode/src/plugin/commands.test.ts':
    'Row lock held across settings publication and a concurrent replacement.',
  'packages/opencode/src/plugin/background-quota-refresh.test.ts':
    'Real fenced-lock renewal and refusal while another poller owns the lock.',
  'packages/opencode/src/plugin/background-vault-quota-refresh.test.ts':
    'Real fenced-lock contention during background vault quota refresh.',
  'packages/opencode/src/plugin/storage.test.ts':
    'Retired pool/pointer preservation, published-generation recovery, and private modes.',
  'packages/opencode/src/plugin/persist-account-pool.test.ts':
    'Lock-held pool persistence, corruption recovery, and chmod-based permission denial.',
  'packages/opencode/src/plugin/vault-custody.test.ts':
    'Ceremony-lock refusal, credential preservation, and directory permission checks.',
  'packages/opencode/src/plugin/ga-shared-vault-custody.test.ts':
    'Shared custody quota producer takes the real fenced poll lock; private-mode vault fixtures.',
  'packages/opencode/src/plugin/vault-stall-recovery.test.ts':
    'Vault source recovery over private-mode enrollment and roster files.',
  'packages/opencode/src/process-heartbeat.test.ts':
    'Heartbeat folder and file modes (0700/0600) and atomic temp-then-rename writes.',
  'packages/opencode/src/version-fence.test.ts':
    'Unreadable (chmod 000) heartbeat and port files, and heartbeats published by temp-then-rename.',
  'packages/opencode/src/runtime-layout.test.ts':
    'Vault-folder move: real fenced leases, durable private copies (0600/0700), hard links, and SIGKILL crash points.',
  'packages/opencode/src/runtime-layout-entry.test.ts':
    'Vault-folder move through each entry point: real layout lease, durable private copies, private-mode (0600/0700) enrollment fixtures.',
  'packages/opencode/src/plugin/config-folder-events.test.ts':
    'File events in the config folder during a vault-mode start: real move and roster locks, private-mode (0600/0700) fixtures, and fs.watch on a real disk.',
  'packages/opencode/src/plugin/vault-activation.test.ts':
    'Native-auth preservation and refusal of unreadable credential directories.',
  'packages/opencode/src/plugin/auth-loader.test.ts':
    'Migration-pending store refusal and private-mode native credential fixtures.',
  'packages/opencode/src/plugin/account-ineligibility.persistence.test.ts':
    'Persisted account-file mode assertions.',
  'packages/opencode/src/plugin/image-saver.test.ts':
    'Private directory and image-file mode assertions.',
  'packages/opencode/src/setup.test.ts':
    'Preserves existing configuration permissions and native credential file modes.',
  'packages/opencode/src/setup-native-path.test.ts':
    'Conservative: private-mode executable and native-credential path fixtures.',
  'packages/opencode/src/cli.test.ts':
    'Native credential file mode assertions and private home/config fixtures.',
  'packages/opencode/src/plugin-entry.test.ts':
    'Conservative: private-mode child readiness, native credentials, and pool fixtures.',
  'packages/opencode/src/plugin/vault-approval.test.ts':
    'Conservative: private-mode project directory fixtures.',
  'packages/opencode/src/plugin/shared/local-grant.test.ts':
    'Conservative: private-mode child scripts and isolated home/config fixtures.',
  'packages/opencode/src/plugin/shared/runtime.test.ts':
    'Conservative: injected lock helper verifies the no-cross-process-lock branch.',
  'packages/opencode/src/plugin/shared/vault-menu.test.ts':
    'Conservative: selector sync calls match the file-handle sync identifier fence.',
  'packages/opencode/src/plugin/shared/vault-request-credentials.test.ts':
    'Conservative: selector sync calls match the file-handle sync identifier fence.',
  'packages/opencode/src/plugin/vault-insula-quota.test.ts':
    'Real provider-state persistence and private-mode enrollment-token fixtures.',
  'packages/opencode/src/plugin/vault-quota-one-commit.test.ts':
    'Real provider-state lock and atomic rename counted per quota check; private-mode enrollment-token fixtures.',
  'packages/opencode/src/plugin/ga-location-services.test.ts':
    'Conservative: private-mode native credential fixtures.',
  'packages/opencode/src/plugin/fetch-interceptor.test.ts':
    'Conservative: private-mode native credential fixtures.',
  'packages/opencode/src/ga/server/pool-login.test.ts':
    'Conservative: private resolved-directory and credential-file fixtures.',
  'packages/opencode/src/plugin/__fixtures__/managed-store.test.ts':
    'Real store helper delegates filesystem lock acquisition.',
  'packages/opencode/src/plugin/__fixtures__/vault-menu-daemon.test.ts':
    'Conservative: private-mode child daemon result fixtures.',
  'packages/opencode/scripts/build-tui.test.ts':
    'Conservative: packaged filesystem lock entry assertions.',
  'packages/pi/src/vault-setup.test.ts':
    'Native credential transition, enrollment locking, and POSIX permission refusal.',
  'packages/pi/src/startup-order.test.ts':
    'Native credential slot transition and private-mode auth/state fixtures.',
  'packages/pi/src/index.test.ts':
    'Native Google credential slot synchronization and private-mode auth/state fixtures.',
  'packages/pi/src/vault-source.test.ts':
    'Mode-file refusal and private-mode dormant native-login preservation.',
  'packages/pi/src/stream.test.ts':
    'Conservative: private-mode native credential fixtures.',
  'packages/e2e-tests/src/v1-unmigrated-upgrade.e2e.test.ts':
    'Upgrade write fence preserves native pool locks and filesystem sidecars.',
  'packages/e2e-tests/src/rpc-tui-flow.e2e.test.ts':
    'Port-file removal on disposal of the real RPC server.',
  'packages/e2e-tests/src/setup.cleanup.test.ts':
    'Physical orphan-root deletion, surviving-root preservation, and read-only cleanup failure.',
  'packages/e2e-tests/src/opencode-ga-harness.test.ts':
    'Native-inert inventory includes owned child-process termination and root cleanup controls.',
  'packages/e2e-tests/src/opencode-ga-inputs.test.ts':
    'Conservative: native-inert inventory links real account-store lifecycle and cleanup controls.',
  'packages/e2e-tests/src/opencode-v2-flow.e2e.test.ts':
    'Private generated-image, log-file, and parent-directory mode assertions.',
  'packages/e2e-tests/src/v1-vault-activation.e2e.test.ts':
    'Conservative: exclusive private-mode native credential capture fixtures.',
  'packages/e2e-tests/docker/ga-contract-inputs.test.ts':
    'Native-inert cleanup, permission metadata, and close-before-rename actor publication.',
  'test/windows-pi-preflight/harness.test.ts':
    'Conservative: private-mode harness executable and connection-file fixtures.',
  'test/build-phase-clock.test.ts':
    'Phase-clock file publication through sibling rename.',
  'test/native-inert-gate.test.ts':
    'Native-inert release-record publication and failed-record cleanup.',
  'test/native-inert-inventory.test.ts':
    'Native-inert cleanup inventory and gate scripts against real temporary Git repositories.',
  'test/common-auth-010-store/public-consumer.test.ts':
    'Public store consumer and parked chunk replacement behavior.',
  'test/common-auth-010-store/pointer-durability.test.ts':
    'Durable pointer publication, recovery, and private file modes.',
  'test/common-auth-010-store/migration-temp-recovery.test.ts':
    'Recovery from migration temporary files and interrupted writes.',
  'test/common-auth-010-store/migration-crash.test.ts':
    'Migration crash seams, restart recovery, and permission refusals.',
  'test/common-auth-010-store/relocation-crash.test.ts':
    'Real-child relocation and downgrade seams, durable native clones, pointer replacement, and sync failures.',
  'test/test-root.test.ts':
    'Live preload disk-root contract and conservative durability identifier fence.',
}
