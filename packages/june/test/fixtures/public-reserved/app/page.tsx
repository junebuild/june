// Minimal one-page app whose public/ tries to smuggle a file under the reserved
// _june/ segment — the build must copy public/ok.txt but skip public/_june/*.
export default function Home() {
  return <main><h1>public reserved fixture</h1></main>;
}
