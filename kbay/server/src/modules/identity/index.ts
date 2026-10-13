// Public API of the identity module. Other modules import only from this file.
export {
  authenticate, login, logout, changePassword, hashPassword, generateTempPassword, loadAccess,
  totpBegin, totpEnable, totpVerifySession, usersWithPermission,
  listUsers, createUser, resetPassword, setUserActive, listRoles, upsertRole, assignRole, revokeRole, setOverride,
  type AuthInfo,
} from './service.js';
