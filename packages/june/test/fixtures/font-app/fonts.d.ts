// A .ttf import is a Data module on workerd (the rule workers() emits): the file's bytes.
declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}
