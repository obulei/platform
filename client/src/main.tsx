import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { AuthProvider } from './auth.js';
import { PlatformAuthProvider } from './platform-auth.js';
import { CLINIC } from './branding.js';
import './styles.css';

// The tab title follows branding.ts, so `client/index.html` only needs its copy
// for the moment before this module runs.
document.title = CLINIC.name;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PlatformAuthProvider>
          <App />
        </PlatformAuthProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
