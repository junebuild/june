// A plain static route — the static() target prerenders it (no `prerender: true`
// needed) and locale-expands it to /about and /de/about.
export const loader = () => ({ title: "About" });
export default function About({ title }: { title: string }) {
  return <main><h1>{title}</h1></main>;
}
export const md = ({ title }: { title: string }) => `# ${title}`;
