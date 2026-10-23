package com.lumi.client;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.Locale;

/**
 * Cliente Android de Lumi.
 *
 * No lleva ninguna dirección escrita dentro: la primera vez pide la URL del
 * servidor y la guarda. Para cambiarla, mantén pulsada la pantalla (o pulsa
 * "Cambiar servidor" cuando no encuentra el servidor).
 */
public class MainActivity extends Activity {

    private static final String PREFS = "lumi";
    private static final String CLAVE_URL = "url";

    private FrameLayout root;
    private WebView web;
    private ProgressBar bar;
    private LinearLayout config;   // pantalla de configuración
    private LinearLayout fallo;    // no encuentro el servidor
    private TextView falloTexto;
    private EditText campoUrl;

    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest permisoPendiente;
    private static final int FILE_REQ = 1001;
    private static final int AUDIO_REQ = 2001;

    private String urlActual = "";
    private int intentos = 0;

    // ------------------------------------------------------------ ciclo de vida

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a0a0f"));
        setContentView(root);

        construirWeb();
        construirFallo();

        String guardada = prefs().getString(CLAVE_URL, "");
        if (guardada == null || guardada.trim().isEmpty()) {
            mostrarConfiguracion(null);
        } else {
            cargar(guardada);
        }

        pedirMicrofonoSiHaceFalta();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    // ---------------------------------------------------------------- WebView

    private void construirWeb() {
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0a0a0f"));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setVisibility(View.GONE);
        root.addView(bar, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 6));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " LumiApp/2.0");
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                if (esDelServidor(req.getUrl())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl()));
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler handler,
                                           android.net.http.SslError e) {
                // El certificado autofirmado solo se acepta en redes privadas.
                // Si el servidor usa un dominio con certificado real, un fallo
                // ahí es un ataque o un problema de verdad: se cancela.
                String host = e.getUrl() != null
                        ? Uri.parse(e.getUrl().toString()).getHost() : "";
                if (esHostPrivado(host)) handler.proceed();
                else handler.cancel();
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                bar.setVisibility(View.GONE);
                fallo.setVisibility(View.GONE);
                intentos = 0;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError e) {
                if (req == null || !req.isForMainFrame()) return;
                reintentarConAlternativa();
            }
        });

        web.setDownloadListener((url, ua, disposition, mime, len) -> {
            String nombre = URLUtil.guessFileName(url, disposition, mime);
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setMimeType(mime);
                req.addRequestHeader("User-Agent", ua);
                req.setTitle(nombre);
                req.setDescription("Lumi");
                req.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(
                        android.os.Environment.DIRECTORY_DOWNLOADS, nombre);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                dm.enqueue(req);
                Toast.makeText(this, "Descargando " + nombre, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) { }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                bar.setVisibility(p < 100 ? View.VISIBLE : View.GONE);
                bar.setProgress(p);
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    permisoPendiente = request;
                    if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                            == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.getResources());
                        permisoPendiente = null;
                    } else {
                        requestPermissions(new String[] {
                                android.Manifest.permission.RECORD_AUDIO }, AUDIO_REQ);
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = cb;
                try {
                    Intent i = params.createIntent();
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(i, FILE_REQ);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }
        });

        // Mantener pulsada la pantalla = cambiar de servidor
        web.setOnLongClickListener(v -> {
            mostrarConfiguracion(urlActual);
            return true;
        });
    }

    // ------------------------------------------------------- pantalla de error

    private void construirFallo() {
        fallo = new LinearLayout(this);
        fallo.setOrientation(LinearLayout.VERTICAL);
        fallo.setGravity(Gravity.CENTER);
        fallo.setPadding(56, 56, 56, 56);
        fallo.setBackgroundColor(Color.parseColor("#0a0a0f"));
        fallo.setVisibility(View.GONE);

        falloTexto = new TextView(this);
        falloTexto.setTextColor(Color.parseColor("#f6f5fa"));
        falloTexto.setTextSize(15f);
        falloTexto.setGravity(Gravity.CENTER);
        fallo.addView(falloTexto);

        Button reintentar = boton("Reintentar");
        reintentar.setOnClickListener(v -> {
            intentos = 0;
            cargar(urlActual);
        });
        fallo.addView(reintentar);

        Button cambiar = boton("Cambiar servidor");
        cambiar.setOnClickListener(v -> mostrarConfiguracion(urlActual));
        fallo.addView(cambiar);

        root.addView(fallo, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    // ---------------------------------------------------- pantalla de servidor

    private void mostrarConfiguracion(String actual) {
        if (config != null) {
            root.removeView(config);
            config = null;
        }
        fallo.setVisibility(View.GONE);
        bar.setVisibility(View.GONE);

        config = new LinearLayout(this);
        config.setOrientation(LinearLayout.VERTICAL);
        config.setGravity(Gravity.CENTER);
        config.setPadding(56, 56, 56, 56);
        config.setBackgroundColor(Color.parseColor("#0a0a0f"));

        TextView titulo = new TextView(this);
        titulo.setText("Lumi");
        titulo.setTextSize(30f);
        titulo.setTypeface(null, android.graphics.Typeface.BOLD);
        titulo.setTextColor(Color.parseColor("#a78bfa"));
        titulo.setGravity(Gravity.CENTER);
        config.addView(titulo);

        TextView sub = new TextView(this);
        sub.setText("Dirección de tu servidor");
        sub.setTextSize(14f);
        sub.setTextColor(Color.parseColor("#8b8797"));
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, 10, 0, 34);
        config.addView(sub);

        campoUrl = new EditText(this);
        campoUrl.setHint("https://mi-servidor:4478");
        campoUrl.setHintTextColor(Color.parseColor("#5b5766"));
        campoUrl.setTextColor(Color.parseColor("#f6f5fa"));
        campoUrl.setTextSize(16f);
        campoUrl.setSingleLine(true);
        campoUrl.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        campoUrl.setPadding(34, 30, 34, 30);
        GradientDrawable caja = new GradientDrawable();
        caja.setColor(Color.parseColor("#14131b"));
        caja.setCornerRadius(26f);
        caja.setStroke(2, Color.parseColor("#3b3550"));
        campoUrl.setBackground(caja);
        if (actual != null && !actual.isEmpty()) campoUrl.setText(actual);
        config.addView(campoUrl, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button conectar = boton("Conectar");
        conectar.setOnClickListener(v -> {
            String url = normalizar(campoUrl.getText().toString());
            if (url == null) {
                Toast.makeText(this, "Dirección no válida", Toast.LENGTH_SHORT).show();
                return;
            }
            prefs().edit().putString(CLAVE_URL, url).apply();
            root.removeView(config);
            config = null;
            intentos = 0;
            cargar(url);
        });
        config.addView(conectar);

        TextView ayuda = new TextView(this);
        ayuda.setText("Ejemplos:\n· https://lumi.micasa.net:4478  (con certificado real)\n"
                + "· http://192.168.1.50:4477  (en tu red local)\n\n"
                + "Mantén pulsada la pantalla para volver aquí.");
        ayuda.setTextSize(12.5f);
        ayuda.setTextColor(Color.parseColor("#5b5766"));
        ayuda.setGravity(Gravity.CENTER);
        ayuda.setPadding(0, 30, 0, 0);
        config.addView(ayuda);

        root.addView(config, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private Button boton(String texto) {
        Button b = new Button(this);
        b.setText(texto);
        b.setAllCaps(false);
        b.setTextSize(16f);
        b.setTextColor(Color.parseColor("#0a0a0f"));
        GradientDrawable fondo = new GradientDrawable();
        fondo.setColor(Color.parseColor("#a78bfa"));
        fondo.setCornerRadius(26f);
        b.setBackground(fondo);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = 26;
        b.setLayoutParams(lp);
        return b;
    }

    // ------------------------------------------------------------- navegación

    private void cargar(String url) {
        urlActual = url;
        fallo.setVisibility(View.GONE);
        bar.setVisibility(View.VISIBLE);
        web.loadUrl(url);
    }

    /** Si falla el https, prueba el mismo host por http antes de rendirse. */
    private void reintentarConAlternativa() {
        intentos++;
        if (intentos == 1 && urlActual.startsWith("https://")) {
            String http = "http://" + urlActual.substring(8);
            // el panel suele escuchar en 4477 cuando el 4478 (https) no responde
            if (http.contains(":4478")) http = http.replace(":4478", ":4477");
            cargar(http);
            return;
        }
        if (intentos < 3) {
            cargar(urlActual);
            return;
        }
        bar.setVisibility(View.GONE);
        falloTexto.setText("No encuentro el servidor.\n\n" + urlActual
                + "\n\nComprueba que Lumi está arrancado y que el móvil está en la misma red"
                + " (o con Tailscale conectado).");
        fallo.setVisibility(View.VISIBLE);
    }

    private boolean esDelServidor(Uri u) {
        String host = u.getHost();
        if (host == null) return false;
        if (esHostPrivado(host)) return true;
        try {
            String propio = Uri.parse(urlActual).getHost();
            return propio != null && propio.equalsIgnoreCase(host);
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean esHostPrivado(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        return h.startsWith("192.168.") || h.startsWith("10.") || h.startsWith("127.")
                || h.equals("localhost") || h.startsWith("100.");
    }

    /** Añade esquema si falta y quita barras finales. */
    private static String normalizar(String bruto) {
        if (bruto == null) return null;
        String u = bruto.trim();
        if (u.isEmpty()) return null;
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        try {
            Uri parsed = Uri.parse(u);
            if (parsed.getHost() == null || parsed.getHost().isEmpty()) return null;
        } catch (Exception e) {
            return null;
        }
        return u;
    }

    // ---------------------------------------------------------------- permisos

    private void pedirMicrofonoSiHaceFalta() {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { android.Manifest.permission.RECORD_AUDIO }, AUDIO_REQ);
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == AUDIO_REQ) {
            if (permisoPendiente != null) {
                if (res.length > 0
                        && res[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    permisoPendiente.grant(permisoPendiente.getResources());
                } else {
                    permisoPendiente.deny();
                }
                permisoPendiente = null;
            }
            return;
        }
        super.onRequestPermissionsResult(req, perms, res);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == FILE_REQ) {
            if (filePathCallback == null) return;
            Uri[] out = null;
            if (res == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    out = new Uri[n];
                    for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    out = new Uri[] { data.getData() };
                }
            }
            filePathCallback.onReceiveValue(out);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (config != null) {
                root.removeView(config);
                config = null;
                if (urlActual.isEmpty()) mostrarConfiguracion(null);
                return true;
            }
            if (web.canGoBack()) {
                web.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }
}
