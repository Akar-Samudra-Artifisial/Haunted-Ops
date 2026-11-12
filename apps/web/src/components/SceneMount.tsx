/**
 * Empty mount point for the house scene. The PixiJS scene arrives in the
 * `scene-engine` spec; this component has no rendering dependency.
 */
export function SceneMount() {
  return <section id="scene-mount" className="scene-mount" aria-label="House scene" />;
}
