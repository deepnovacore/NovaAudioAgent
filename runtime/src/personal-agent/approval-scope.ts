import type {ApprovalController,ApprovalView} from '../core/approval-port.js'
const empty:ApprovalView={pending_approval:false,pending_approval_busy:false,kind:null,local_detail:null,operation_summary:null,expires_at:null,work:null,queued:0}
/** Scope every read and mutation, including implicit hold/invalidate operations. */
export function scopeApprovalController(broker:ApprovalController,owns:(view:ApprovalView)=>boolean):ApprovalController {
 return {get view(){return owns(broker.view)?broker.view:empty},get pending(){return owns(broker.view)&&broker.pending},
  observe:listener=>broker.observe(view=>listener(owns(view)?view:empty)),
  acceptDecision:input=>owns(broker.view)&&broker.acceptDecision(input),invalidate:reason=>owns(broker.view)&&broker.invalidate(reason),hold:reason=>owns(broker.view)&&broker.hold(reason),release:(reason,options)=>owns(broker.view)&&broker.release(reason,options)}
}
