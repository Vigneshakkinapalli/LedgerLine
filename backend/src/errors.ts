export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
export const forbidden = () => new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
export const validationError = (message = 'Request validation failed') => new AppError(400, 'VALIDATION_ERROR', message);
