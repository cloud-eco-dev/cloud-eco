// Состояние
let currentTab = 'login';

// Переключение вкладок
window.switchTab = function(tab) {
    currentTab = tab;
    
    // Обновляем классы кнопок
    document.getElementById('loginTab').classList.remove('active');
    document.getElementById('registerTab').classList.remove('active');
    document.getElementById(tab === 'login' ? 'loginTab' : 'registerTab').classList.add('active');
    
    // Обновляем формы
    document.getElementById('loginForm').classList.remove('active');
    document.getElementById('registerForm').classList.remove('active');
    document.getElementById(tab === 'login' ? 'loginForm' : 'registerForm').classList.add('active');
    
    // Скрываем ошибки
    hideError();
};

// Показать ошибку
function showError(message) {
    const errorDiv = document.getElementById('errorMessage');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    
    setTimeout(() => {
        errorDiv.style.display = 'none';
    }, 5000);
}

// Скрыть ошибку
function hideError() {
    document.getElementById('errorMessage').style.display = 'none';
}

// Показать загрузку
function setLoading(form, loading) {
    const btn = document.getElementById(form === 'login' ? 'loginBtn' : 'registerBtn');
    const span = btn.querySelector('span');
    const spinner = btn.querySelector('i');
    
    btn.disabled = loading;
    span.style.opacity = loading ? '0.7' : '1';
    spinner.style.display = loading ? 'inline-block' : 'none';
}

// Вход
window.login = async function(event) {
    event.preventDefault();
    
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    
    if (!email || !password) {
        showError('Заполните все поля');
        return;
    }
    
    setLoading('login', true);
    hideError();
    
    try {
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        if (!user.emailVerified) {
            showError('Пожалуйста, подтвердите email. Проверьте почту.');
            setLoading('login', false);
            return;
        }
        
        // Сохраняем UID и перенаправляем на главную
        localStorage.setItem('userUID', user.uid);
        localStorage.setItem('userEmail', user.email);
        
        // Получаем токен для API
        const token = await user.getIdToken();
        localStorage.setItem('token', token);
        
        window.location.href = '/';
        
    } catch (error) {
        console.error('Login error:', error);
        
        switch(error.code) {
            case 'auth/user-not-found':
            case 'auth/wrong-password':
            case 'auth/invalid-credential':
                showError('Неверный email или пароль');
                break;
            case 'auth/too-many-requests':
                showError('Слишком много попыток. Попробуйте позже');
                break;
            case 'auth/user-disabled':
                showError('Аккаунт заблокирован');
                break;
            default:
                showError('Ошибка входа: ' + error.message);
        }
        
        setLoading('login', false);
    }
};

// Регистрация
window.register = async function(event) {
    event.preventDefault();
    
    const name = document.getElementById('registerName').value;
    const email = document.getElementById('registerEmail').value;
    const password = document.getElementById('registerPassword').value;
    
    if (!name || !email || !password) {
        showError('Заполните все поля');
        return;
    }
    
    if (password.length < 6) {
        showError('Пароль должен быть минимум 6 символов');
        return;
    }
    
    setLoading('register', true);
    hideError();
    
    try {
        // Создаем пользователя
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        // Обновляем профиль с именем
        await user.updateProfile({
            displayName: name
        });
        
        let actionCodeSettings = {
            url: window.location.origin + '/login', 
            handleCodeInApp: true
        };
        
        actionCodeSettings = 'https://www.net-cloud.ru/login';   
        
        await user.sendEmailVerification(actionCodeSettings);
        
        document.getElementById('verifyModal').classList.add('show');
        
        await auth.signOut();
        
    } catch (error) {
        console.error('Register error:', error);
        
        switch(error.code) {
            case 'auth/email-already-in-use':
                showError('Этот email уже зарегистрирован');
                break;
            case 'auth/invalid-email':
                showError('Неверный формат email');
                break;
            case 'auth/weak-password':
                showError('Слишком простой пароль');
                break;
            default:
                showError('Ошибка регистрации: ' + error.message);
        }
        
        setLoading('register', false);
    }
};

auth.onAuthStateChanged(async (user) => {
    if (user && user.emailVerified) {
        // Уже авторизован, перенаправляем на главную
        localStorage.setItem('userUID', user.uid);
        localStorage.setItem('userEmail', user.email);
        
        const token = await user.getIdToken();
        localStorage.setItem('token', token);
        
        window.location.href = '/';
    }

});







