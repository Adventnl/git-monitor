import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

class AppErrorBoundary extends Component<{children:ReactNode},{message:string|null}> {
  state:{message:string|null} = {message:null};
  static getDerivedStateFromError(error:Error) { return {message:error.message || 'An unexpected error occurred'}; }
  componentDidCatch(error:Error, info:ErrorInfo) { console.error('git-monitor UI error',error,info); }
  render() {
    if(this.state.message) return <main className="app app-error"><div><h1>Something went wrong</h1><p>{this.state.message}</p><button className="primary-button" onClick={()=>window.location.reload()}>Reload git-monitor</button></div></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><AppErrorBoundary><App /></AppErrorBoundary></React.StrictMode>);
