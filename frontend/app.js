let token = null;
const API_BASE = window.location.origin.replace(/:\d+$/, ':8000'); // assume backend on 8000

function setToken(t) {
  token = t;
  const el = document.getElementById('login-result');
  if (el) el.textContent = "Logged in. Token stored in memory.";
}

async function register() {
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-pass').value;
  const resEl = document.getElementById('reg-result');
  resEl.textContent = "Registering...";
  try {
    const res = await fetch(API_BASE + '/auth/register', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email, password})
    });
    const data = await res.json();
    resEl.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    resEl.textContent = 'Error: ' + e;
  }
}

async function login() {
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-pass').value;
  const resEl = document.getElementById('login-result');
  resEl.textContent = "Logging in...";
  const params = new URLSearchParams();
  params.append('username', email);
  params.append('password', password);
  try {
    const res = await fetch(API_BASE + '/auth/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: params.toString()
    });
    const data = await res.json();
    if (data.access_token) {
      setToken(data.access_token);
    } else {
      resEl.textContent = JSON.stringify(data, null, 2);
    }
  } catch (e) {
    resEl.textContent = 'Error: ' + e;
  }
}

async function createStrategy() {
  const name = document.getElementById('strat-name').value;
  const description = document.getElementById('strat-desc').value;
  const specText = document.getElementById('strat-spec').value || '{}';
  const resEl = document.getElementById('strat-create-result');
  if (!token) {
    resEl.textContent = "Please login first.";
    return;
  }
  let spec;
  try {
    spec = JSON.parse(specText);
  } catch (e) {
    resEl.textContent = "Spec JSON invalid: " + e;
    return;
  }
  try {
    const res = await fetch(API_BASE + '/strategies/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({name, description, spec_json: spec})
    });
    const data = await res.json();
    resEl.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    resEl.textContent = 'Error: ' + e;
  }
}

async function loadStrategies() {
  const el = document.getElementById('strat-list');
  if (!token) {
    el.textContent = "Please login first.";
    return;
  }
  try {
    const res = await fetch(API_BASE + '/strategies/', {
      headers: {'Authorization': 'Bearer ' + token}
    });
    const data = await res.json();
    el.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    el.textContent = 'Error: ' + e;
  }
}

async function getTicker() {
  const symbol = document.getElementById('market-symbol').value || 'AVAXUSDT';
  const exchange = document.getElementById('market-exchange').value || 'binance';
  const el = document.getElementById('market-result');
  el.textContent = 'Loading...';
  try {
    const res = await fetch(API_BASE + '/market/ticker/' + encodeURIComponent(symbol) + '?exchange=' + encodeURIComponent(exchange));
    const data = await res.json();
    el.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    el.textContent = 'Error: ' + e;
  }
}

async function getPrediction() {
  const symbol = document.getElementById('pred-symbol').value || 'AVAXUSDT';
  const exchange = document.getElementById('pred-exchange').value || 'binance';
  const el = document.getElementById('pred-result');
  el.textContent = 'Loading...';
  try {
    const res = await fetch(API_BASE + '/predict/' + encodeURIComponent(symbol) + '?exchange=' + encodeURIComponent(exchange));
    const data = await res.json();
    el.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    el.textContent = 'Error: ' + e;
  }
}
