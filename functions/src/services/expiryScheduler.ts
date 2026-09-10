import { getFunctions, type Functions } from "firebase-admin/functions";

export interface ExpiryScheduler {
  enqueue(requestId: string, scheduleTime: Date): Promise<void>;
}

export class FirebaseTaskQueueExpiryScheduler implements ExpiryScheduler {
  constructor(private readonly functions: Functions = getFunctions()) {}

  async enqueue(requestId: string, scheduleTime: Date): Promise<void> {
    await this.functions.taskQueue("locations/asia-south1/functions/expirePhoneRequest").enqueue(
      { requestId },
      { scheduleTime },
    );
  }
}
