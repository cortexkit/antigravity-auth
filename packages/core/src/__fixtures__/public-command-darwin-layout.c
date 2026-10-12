#include <errno.h>
#include <libproc.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/proc.h>

/* Verification only: derive the ABI from actual SDK types, never a copied struct. */
int main(void) {
  printf("{\"size\":%zu,\"pidSize\":%zu,\"allPids\":%d,\"bsdInfo\":%d,\"zombie\":%d,\"missingError\":%d,"
         "\"offsets\":{\"pid\":%zu,\"ppid\":%zu,\"pgid\":%zu,\"status\":%zu,"
         "\"seconds\":%zu,\"microseconds\":%zu}}\n",
         sizeof(struct proc_bsdinfo), sizeof(pid_t), PROC_ALL_PIDS,
         PROC_PIDTBSDINFO, SZOMB, ESRCH,
         offsetof(struct proc_bsdinfo, pbi_pid),
         offsetof(struct proc_bsdinfo, pbi_ppid),
         offsetof(struct proc_bsdinfo, pbi_pgid),
         offsetof(struct proc_bsdinfo, pbi_status),
         offsetof(struct proc_bsdinfo, pbi_start_tvsec),
         offsetof(struct proc_bsdinfo, pbi_start_tvusec));
  return 0;
}
