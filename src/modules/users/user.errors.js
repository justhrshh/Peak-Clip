import { AppError } from '../../utils/errors.js';

export class UserNotFoundError extends AppError {
  constructor(identifier) {
    super(`User not found: ${identifier}`, 'USER_NOT_FOUND', 404, { identifier });
  }
}

export class UserSuspendedError extends AppError {
  constructor(userId, reason = 'Account is suspended') {
    super(`User account is suspended: ${reason}`, 'USER_SUSPENDED', 403, { userId, reason });
  }
}

export class UserBannedError extends AppError {
  constructor(userId, reason = 'Account is banned') {
    super(`User account is permanently banned: ${reason}`, 'USER_BANNED', 403, { userId, reason });
  }
}

export class UserInactiveError extends AppError {
  constructor(userId, status) {
    super(`User account is not active (current status: ${status})`, 'USER_INACTIVE', 403, { userId, status });
  }
}
