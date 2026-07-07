export type BullLikeQueueAddOptions = {
  readonly jobId?: string;
  readonly attempts?: number;
  readonly delay?: number;
  readonly backoff?:
    | number
    | {
        readonly type: "fixed" | "exponential";
        readonly delay: number;
      };
  readonly removeOnComplete?: boolean | number;
  readonly removeOnFail?: boolean | number;
};

export type BullLikeQueue<Job> = {
  add(
    name: string,
    data: Job,
    options?: BullLikeQueueAddOptions,
  ): Promise<{ readonly id?: string | number }>;
  count?(): Promise<number>;
};

export type BullLikeJob<Job> = {
  readonly id?: string | number;
  readonly data: Job;
  readonly attemptsMade?: number;
  readonly name?: string;
};
