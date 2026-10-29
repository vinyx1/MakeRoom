import { createRoot } from 'react-dom/client';
// Bryntum needs all three: structural CSS, exactly one theme, and FontAwesome (its own CLAUDE.md).
import '@bryntum/schedulerpro/schedulerpro.css';
import '@bryntum/schedulerpro/svalbard-light.css';
import '@bryntum/schedulerpro/fontawesome/css/fontawesome.css';
import '@bryntum/schedulerpro/fontawesome/css/solid.css';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
