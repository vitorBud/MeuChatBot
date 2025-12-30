import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

// se seu CSS global está em src/styles/style.css:
import './styles/style.css';
import './styles/sidebar.css';
import './styles/previsoes.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
  