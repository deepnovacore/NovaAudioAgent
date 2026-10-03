const sameBounds=(a,b)=>!!a&&!!b&&a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height

/**
 * Maximize for a transparent, non-maximizable window is a bounds toggle: the native flag is unreliable there.
 * A window counts as maximized only while its bounds still equal what this toggle set, so a manual move or
 * resize afterwards makes the next toggle maximize again instead of jumping back to a stale rectangle.
 */
export function createWorkbenchFrame({getBounds,setBounds,getWorkArea}){
 let restoreBounds=null,maximizedBounds=null
 // A display change can make the OS re-fit a maximized window; one that still fills its work area is still maximized.
 const maximized=()=>{
  if(restoreBounds===null)return false
  const current=getBounds()
  return sameBounds(current,maximizedBounds)||sameBounds(current,getWorkArea(current))
 }
 return {
  get maximized(){return maximized()},
  toggleMaximize(){
   if(maximized()){const back=restoreBounds;restoreBounds=null;maximizedBounds=null;setBounds(back);return false}
   const current=getBounds(),area=getWorkArea(current)
   restoreBounds=current;maximizedBounds={x:area.x,y:area.y,width:area.width,height:area.height}
   setBounds(maximizedBounds);return true
  },
  /** The rectangle the workbench should come back to: the pre-maximize one while maximized. */
  naturalBounds(){return maximized()?restoreBounds:getBounds()},
  forget(){restoreBounds=null;maximizedBounds=null},
 }
}
