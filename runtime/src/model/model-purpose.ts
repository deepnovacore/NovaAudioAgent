import {AsyncLocalStorage} from 'node:async_hooks'
/** Which feature a model request serves, so diagnostics can tell a profile call from an embedding batch. */
export type ModelPurpose='profile'|'context'|'embedding'|'recall'|'digest'
const scope=new AsyncLocalStorage<ModelPurpose>()
export function withModelPurpose<T>(purpose:ModelPurpose,run:()=>T):T{return scope.run(purpose,run)}
export function currentModelPurpose():ModelPurpose|'other'{return scope.getStore()??'other'}
