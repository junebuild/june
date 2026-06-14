import styles from "./Home.module.css";
export const prerender = true;
export default function Home() {
  return <main className={styles.hero}><h1 className={styles.title}>styled</h1></main>;
}
