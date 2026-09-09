import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./style.css";
import "./tactical.css";

/**
 * Last line of defence against a blank page: a render error anywhere in the
 * app shows a recover panel instead of an empty white screen. Re-mounting
 * keeps the session (sessionStorage) and refetches the same match.
 */
class RecoverBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, generation: 0 };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("들녘 화면 오류", error, info?.componentStack);
  }
  render() {
    if (this.state.error)
      return (
        <main className="loading-screen recover-screen" role="alert">
          <div className="wordmark">
            들녘<span>FIELDLINE</span>
          </div>
          <p>화면을 그리다 문제가 생겼어요. 경기는 서버에 그대로 있어요.</p>
          <code className="recover-detail">
            {String(this.state.error?.message ?? this.state.error)}
          </code>
          <div className="time-presets">
            <button
              className="primary"
              onClick={() =>
                this.setState({ error: null, generation: this.state.generation + 1 })
              }
            >
              같은 경기로 다시 그리기
            </button>
            <button onClick={() => location.reload()}>새로고침</button>
          </div>
        </main>
      );
    return <App key={this.state.generation} />;
  }
}

createRoot(document.getElementById("root")).render(<RecoverBoundary />);
