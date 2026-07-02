export const loader = () => ({ title: "Home" });
export default function Home({ title }: { title: string }) {
  return <main><h1>{title}</h1></main>;
}
export const md = ({ title }: { title: string }) => `# ${title}`;
export const json = ({ title }: { title: string }) => ({ title });
