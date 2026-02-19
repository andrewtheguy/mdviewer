import { DocumentViewer } from "./DocumentViewer";
import "./index.css";
import { LoginView } from "@/components/LoginView";
import { useAuth } from "@/hooks/useAuth";
import { Loader2 } from "lucide-react";

export function App() {
  const { status, error, isLoggingIn, login, logout, markUnauthorized } = useAuth();

  if (status === "checking") {
    return (
      <div className="container mx-auto p-4 sm:p-6 md:p-8">
        <div className="flex min-h-[40vh] items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <span>Checking authentication...</span>
        </div>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <LoginView
        error={error}
        isLoading={isLoggingIn}
        onLogin={login}
      />
    );
  }

  return (
    <div className="container mx-auto p-0 sm:p-4 md:p-8 relative z-10">
      <DocumentViewer onLogout={logout} onUnauthorized={markUnauthorized} />
    </div>
  );
}

export default App;
