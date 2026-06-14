// Ambient types for CSS Modules: `import styles from "./X.module.css"` resolves
// to a map of local class name → scoped name. June ships this so app code (and
// these tests/fixtures) typecheck; the create-june template references an
// equivalent june-env.d.ts. (No top-level import/export → this is a GLOBAL
// declaration, so the ambient module applies everywhere.)
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
