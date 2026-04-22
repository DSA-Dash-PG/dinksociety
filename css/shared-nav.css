/* ===========================================================
   Mobile navigation — hamburger + slide-out drawer
   Shared between public site, captain portal, admin portal.
   Append this to /css/shared.css or include as a separate file.
   =========================================================== */

/* The hamburger button — always present in the DOM, only visible under 720px */
.ds-hamburger {
  display: none;
  width: 44px;
  height: 44px;
  padding: 10px;
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 6px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 5px;
}
.ds-hamburger:hover { background: rgba(245, 235, 212, 0.08); }
.ds-hamburger__line {
  display: block;
  width: 22px;
  height: 2px;
  background: currentColor;
  border-radius: 1px;
  transition: transform 0.2s ease, opacity 0.2s ease;
}

/* When drawer is open, transform the lines into an X */
.ds-hamburger.is-open .ds-hamburger__line:nth-child(1) {
  transform: translateY(7px) rotate(45deg);
}
.ds-hamburger.is-open .ds-hamburger__line:nth-child(2) {
  opacity: 0;
}
.ds-hamburger.is-open .ds-hamburger__line:nth-child(3) {
  transform: translateY(-7px) rotate(-45deg);
}

/* Drawer backdrop — full-viewport overlay */
.ds-drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(13, 59, 64, 0.5);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
  z-index: 998;
}
.ds-drawer-backdrop.is-open {
  opacity: 1;
  pointer-events: auto;
}

/* The drawer itself — slides in from the right */
.ds-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 280px;
  max-width: 85vw;
  background: #0D3B40;
  color: #F5EBD4;
  transform: translateX(100%);
  transition: transform 0.25s ease;
  z-index: 999;
  display: flex;
  flex-direction: column;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.15);
}
.ds-drawer.is-open {
  transform: translateX(0);
}

.ds-drawer__header {
  padding: 20px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(232, 181, 66, 0.2);
}
.ds-drawer__brand {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-style: italic;
  font-size: 18px;
  color: #E8B542;
  font-weight: 500;
}
.ds-drawer__close {
  background: transparent;
  border: none;
  color: #F5EBD4;
  font-size: 28px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}
.ds-drawer__close:hover { background: rgba(245, 235, 212, 0.08); }

.ds-drawer__body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
}

.ds-drawer__section {
  padding: 8px 0;
}
.ds-drawer__section + .ds-drawer__section {
  border-top: 1px solid rgba(245, 235, 212, 0.1);
  margin-top: 8px;
  padding-top: 16px;
}
.ds-drawer__section-label {
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #E8B542;
  opacity: 0.7;
  font-weight: 500;
  padding: 4px 12px 10px;
}

.ds-drawer__link {
  display: block;
  padding: 12px 14px;
  border-radius: 6px;
  color: #F5EBD4;
  text-decoration: none;
  font-size: 15px;
  font-weight: 400;
  background: transparent;
  border: none;
  width: 100%;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease;
}
.ds-drawer__link:hover,
.ds-drawer__link:focus {
  background: rgba(245, 235, 212, 0.08);
  outline: none;
}
.ds-drawer__link.is-active {
  background: rgba(232, 181, 66, 0.15);
  color: #E8B542;
  font-weight: 500;
}

.ds-drawer__footer {
  padding: 16px 20px;
  border-top: 1px solid rgba(245, 235, 212, 0.1);
  font-size: 11px;
  opacity: 0.55;
}

/* Responsive triggers */
@media (max-width: 720px) {
  .ds-hamburger { display: flex; }
  /* Hide the inline/horizontal nav links so only the hamburger remains */
  .ds-nav-inline { display: none !important; }
}

/* Prevent background scroll when drawer is open */
body.ds-drawer-open {
  overflow: hidden;
}
