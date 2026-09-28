export const loader = ({ params }: { params: { slug?: string } }) => ({ slug: params.slug ?? "" });
export default function Page({ slug }: { slug: string }) {
  return <main><h1>{slug || "home"}</h1></main>;
}
export const json = ({ slug }: { slug: string }) => ({ slug });
export const staticPaths = ["/"];
