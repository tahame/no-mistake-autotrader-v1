// Public API of the approvals module (approval requests, decisions, and entry comments/questions).
export {
  registerApprovalHandler, requestApproval, approversFor, decide, cancel, list, get, sendReminders, type ApprovalHandler,
} from './service.js';
export { listComments, addComment, questionFollowups } from './comments.js';
