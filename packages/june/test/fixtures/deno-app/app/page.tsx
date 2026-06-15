export const loader = () => ({ title: "Deno" });
export default function Home({ title }: { title: string }) {
  return <main><h1>Hello from {title}</h1></main>;
}
export const md = ({ title }: { title: string }) => `# ${title}`;
