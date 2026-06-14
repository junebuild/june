// CSS Modules: `import styles from "./X.module.css"` → a map of class name →
// scoped name. June scopes them per-component at build/dev.
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
