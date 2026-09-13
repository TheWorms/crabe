'use strict';

/**
 * Écran de connexion. Le serveur pilote le parcours en renvoyant `step` :
 *
 *   'done'       -> session ouverte, on entre (cas le plus courant : la 2FA est
 *                   optionnelle et désactivée par défaut) ;
 *   '2fa'        -> le compte a sa propre 2FA, on demande le code ;
 *   '2fa-setup'  -> l'administrateur exige la 2FA et ce compte n'en a pas :
 *                   on l'invite, avec une porte de sortie (« Plus tard »).
 *
 * Aucun écran de code n'apparaît si le compte n'a pas la 2FA.
 *
 * Cas particulier du tout premier démarrage : tant que la base ne compte AUCUN
 * utilisateur (GET /auth/premier-compte), l'écran affiché est celui de la
 * création du compte administrateur. Il disparaît pour toujours dès qu'un
 * compte existe — le serveur re-vérifie ce vide au moment de créer.
 */

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    /* réponse vide */
  }
  if (!res.ok) throw new Error(payload.error || `Erreur ${res.status}`);
  return payload;
}

function showError(id, message) {
  const box = $(id);
  box.textContent = message;
  box.classList.add('show');
}

function clearError(id) {
  $(id).classList.remove('show');
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function showScreen(name) {
  for (const id of ['screen-login', 'screen-premier', 'screen-2fa', 'screen-2fa-setup']) {
    $(id).style.display = id === `screen-${name}` ? 'flex' : 'none';
  }
}

function busy(button, isBusy, label) {
  button.disabled = isBusy;
  button.innerHTML = isBusy ? '<span class="spinner"></span> ' + label : label;
}

// --- Étape 1 : identifiants -------------------------------------------------

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('login-error');
  const button = $('login-submit');
  busy(button, true, 'Connexion…');

  try {
    const result = await api('/auth/login', {
      method: 'POST',
      body: {
        username: $('login-username').value.trim(),
        password: $('login-password').value,
      },
    });

    if (result.step === 'done') return void (location.href = '/app');
    if (result.step === '2fa') {
      showScreen('2fa');
      document.querySelector('.otp').focus();
      return;
    }
    if (result.step === '2fa-setup') return void startEnrollment(result.canSkip);
  } catch (err) {
    showError('login-error', err.message);
  } finally {
    busy(button, false, 'Se connecter');
  }
});

// --- Premier démarrage : création du compte administrateur -------------------

$('premier-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('premier-error');

  if ($('premier-password').value !== $('premier-confirm').value) {
    showError('premier-error', 'Les deux mots de passe ne correspondent pas.');
    $('premier-confirm').focus();
    return;
  }

  const button = $('premier-submit');
  busy(button, true, 'Création…');

  try {
    await api('/auth/premier-compte', {
      method: 'POST',
      body: {
        username: $('premier-username').value.trim(),
        password: $('premier-password').value,
      },
    });
    // La session est ouverte par la route elle-même : on entre directement.
    location.href = '/app';
  } catch (err) {
    showError('premier-error', err.message);
    // Si quelqu'un d'autre vient de créer LE compte (instance partagée),
    // la seule suite honnête est l'écran de connexion.
    if (/existe déjà/i.test(err.message)) {
      setTimeout(() => showScreen('login'), 1600);
    }
  } finally {
    busy(button, false, 'Créer le compte et entrer');
  }
});

// --- Étape 2 : code TOTP ----------------------------------------------------

const otpInputs = [...document.querySelectorAll('.otp')];

otpInputs.forEach((input, index) => {
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '');
    if (input.value && otpInputs[index + 1]) otpInputs[index + 1].focus();
    if (otpInputs.every((i) => i.value)) $('otp-form').requestSubmit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && !input.value && otpInputs[index - 1]) {
      otpInputs[index - 1].focus();
    }
  });
  input.addEventListener('paste', (event) => {
    const digits = (event.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!digits) return;
    event.preventDefault();
    digits.split('').forEach((d, i) => {
      if (otpInputs[i]) otpInputs[i].value = d;
    });
    if (digits.length === 6) $('otp-form').requestSubmit();
  });
});

$('otp-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('otp-error');
  const code = otpInputs.map((i) => i.value).join('');
  if (code.length !== 6) return;

  const button = $('otp-submit');
  busy(button, true, 'Vérification…');
  try {
    await api('/auth/2fa', { method: 'POST', body: { code } });
    location.href = '/app';
  } catch (err) {
    showError('otp-error', err.message);
    otpInputs.forEach((i) => (i.value = ''));
    otpInputs[0].focus();
  } finally {
    busy(button, false, 'Vérifier');
  }
});

// --- Étape 2 bis : enrôlement 2FA ------------------------------------------

async function startEnrollment(canSkip = false) {
  clearError('setup-error');
  try {
    const setup = await api('/auth/2fa/setup', { method: 'POST' });
    $('setup-qr').src = setup.qr;
    $('setup-secret').textContent = setup.secret;
    // Jamais de cul-de-sac : si la 2FA est impossible à configurer maintenant
    // (téléphone perdu, application absente), on peut entrer quand même.
    $('setup-skip').style.display = canSkip ? 'block' : 'none';
    showScreen('2fa-setup');
    $('setup-code').focus();
  } catch (err) {
    // Politique changée entre-temps, ou 2FA désactivée par l'administrateur.
    showError('login-error', err.message);
    showScreen('login');
  }
}

/** Porte de sortie de l'enrôlement obligatoire. */
async function skipEnrollment() {
  clearError('setup-error');
  try {
    await api('/auth/2fa/skip', { method: 'POST' });
    location.href = '/app';
  } catch (err) {
    showError('setup-error', err.message);
  }
}

$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('setup-error');
  const button = $('setup-submit');
  busy(button, true, 'Activation…');

  try {
    await api('/auth/2fa/confirm', {
      method: 'POST',
      body: { code: $('setup-code').value.replace(/\s/g, '') },
    });
    showToast('Double authentification activée');
    location.href = '/app';
  } catch (err) {
    showError('setup-error', err.message);
    $('setup-code').value = '';
    $('setup-code').focus();
  } finally {
    busy(button, false, 'Activer la 2FA et se connecter');
  }
});

// --- Au chargement ----------------------------------------------------------
//
// 1. Session encore valide -> on entre sans rien demander.
// 2. Base sans aucun utilisateur -> écran de création du premier compte.
// 3. Sinon -> écran de connexion (déjà affiché par défaut).
(async () => {
  try {
    await api('/auth/me');
    location.href = '/app';
    return;
  } catch {
    /* non authentifié : comportement normal */
  }
  try {
    const etat = await api('/auth/premier-compte');
    if (etat.vierge) {
      showScreen('premier');
      $('premier-username').focus();
    }
  } catch {
    /* au moindre doute, l'écran de connexion reste : il ne crée rien */
  }
})();
