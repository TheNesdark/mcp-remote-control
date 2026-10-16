/**
 * PowerShell helper sources imported as text so `bun build --compile` embeds
 * them inside rc-agent.exe (verified: embedded content survives compilation
 * and needs no sidecar files at runtime).
 */
declare module "*.ps1" {
  const content: string;
  export default content;
}
