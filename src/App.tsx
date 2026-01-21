import { S3FileManager } from "./S3FileManager";
import "./index.css";

export function App() {
  return (
    <div className="container mx-auto p-8 relative z-10">
      <S3FileManager />
    </div>
  );
}

export default App;
