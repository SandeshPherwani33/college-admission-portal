import { Component, ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { hasError: boolean };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="error-boundary" role="alert">
          <div className="error-boundary-card">
            <p className="eyebrow">UniApply-AI</p>
            <h1>This page could not be displayed</h1>
            <p>Reload the application to continue. Your saved profile and document data have not been changed.</p>
            <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
              Reload application
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
