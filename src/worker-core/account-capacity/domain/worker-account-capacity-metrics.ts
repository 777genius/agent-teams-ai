export enum WorkerAccountCapacityMetric {
  RecheckDue = "subscription_runtime.worker_account_capacity_recheck_due",
  RecheckBusy = "subscription_runtime.worker_account_capacity_recheck_busy",
  RecheckFailed = "subscription_runtime.worker_account_capacity_recheck_failed",
  LockRecovery = "subscription_runtime.worker_account_capacity_lock_recovery",
  TimeToResetMs = "subscription_runtime.worker_account_capacity_time_to_reset_ms",
}
