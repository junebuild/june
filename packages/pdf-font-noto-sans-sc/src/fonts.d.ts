// An .otf import is a Data module on workerd (wrangler's Data rule): the file's bytes.
declare module "*.otf" {
  const data: ArrayBuffer;
  export default data;
}
