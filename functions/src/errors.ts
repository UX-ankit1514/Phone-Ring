export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  unauthenticated: () => new AppError("UNAUTHENTICATED", "Authentication is required.", 401),
  forbidden: (message = "You are not allowed to perform this action.") =>
    new AppError("FORBIDDEN", message, 403),
  invalidRequest: (details?: Record<string, unknown>) =>
    new AppError("INVALID_ARGUMENT", "The request is invalid.", 400, false, details),
  profileMissing: () =>
    new AppError("PROFILE_REQUIRED", "Complete your display name before requesting the phone.", 409),
  activeRequest: (requestId: string) =>
    new AppError(
      "ACTIVE_REQUEST_EXISTS",
      "The UAE phone is already being requested. Please wait for the current request to finish.",
      409,
      false,
      { requestId },
    ),
  cooldown: (retryAfterSeconds: number) =>
    new AppError(
      "TARGETTER_COOLDOWN",
      "Please wait before creating another phone request.",
      429,
      true,
      { retryAfterSeconds },
    ),
  targetUnavailable: () =>
    new AppError("TARGET_UNAVAILABLE", "The UAE phone is not registered or active.", 503, true),
  requestNotFound: () => new AppError("REQUEST_NOT_FOUND", "Phone request not found.", 404),
  invalidTransition: (from: string, to: string) =>
    new AppError("INVALID_STATE_TRANSITION", `Cannot transition request from ${from} to ${to}.`, 409),
  requestExpired: () => new AppError("REQUEST_EXPIRED", "This phone request has expired.", 409),
  fcmFailed: () =>
    new AppError("FCM_SEND_FAILED", "Unable to send the phone request. Please try again.", 503, true),
  enrollmentInvalid: () =>
    new AppError("DEVICE_ENROLLMENT_INVALID", "The enrollment code is invalid or has already been used.", 403),
};
