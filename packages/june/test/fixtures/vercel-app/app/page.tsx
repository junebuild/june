export const prerender = true;
export const loader = () => ({ title: "Vercel" });
export default function Home({ title }: { title: string }) {
  return <main><h1>{title}</h1></main>;
}
export const md = ({ title }: { title: string }) => `# ${title}`;
