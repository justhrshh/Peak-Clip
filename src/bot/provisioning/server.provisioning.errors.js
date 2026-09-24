/**
 * Base Provisioning Domain Error
 */
export class ProvisioningError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
  }
}

/**
 * Thrown when provisioning is executed against an unauthorized or mismatched guild
 */
export class GuildMismatchError extends ProvisioningError {
  constructor(attemptedGuildId, expectedGuildId) {
    super(
      `Provisioning rejected: Guild ID '${attemptedGuildId}' does not match configured target '${expectedGuildId}'.`,
      { attemptedGuildId, expectedGuildId }
    );
  }
}

/**
 * Thrown when the invoking user lacks the required Peak Admin administrative privileges
 */
export class UnauthorizedProvisioningError extends ProvisioningError {
  constructor(userId, reason = 'Peak Admin authorization required to provision server.') {
    super(reason, { userId });
  }
}

/**
 * Thrown when Discord role hierarchy prevents the bot from managing or positioning required roles
 */
export class RoleHierarchyError extends ProvisioningError {
  constructor(roleName, botHighestPosition, targetPosition) {
    super(
      `Role hierarchy conflict: Cannot manage role '${roleName}'. Bot highest role position (${botHighestPosition}) must be above target position (${targetPosition}).`,
      { roleName, botHighestPosition, targetPosition }
    );
  }
}

/**
 * Thrown when an existing resource with the target name exists but has an incompatible type or structure
 */
export class ProvisioningConflictError extends ProvisioningError {
  constructor(resourceName, expectedType, actualType) {
    super(
      `Provisioning conflict: Resource '${resourceName}' exists but has incompatible type '${actualType}' (expected '${expectedType}').`,
      { resourceName, expectedType, actualType }
    );
  }
}
