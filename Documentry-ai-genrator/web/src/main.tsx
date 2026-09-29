import React from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './Shell';
import './styles.css';
import './overhaul.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

createRoot(container).render(
	<React.StrictMode>
		<Shell />
	</React.StrictMode>,
);
