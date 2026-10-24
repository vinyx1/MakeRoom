import { createRoot } from 'react-dom/client';
import '@bryntum/schedulerpro/schedulerpro.css';
import '@bryntum/schedulerpro/stockholm-light.css';
import '@bryntum/schedulerpro/fontawesome/css/fontawesome.css';
import '@bryntum/schedulerpro/fontawesome/css/solid.css';
import './app.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
