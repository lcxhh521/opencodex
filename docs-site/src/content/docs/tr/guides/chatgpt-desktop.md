---
title: ChatGPT Masaüstü Gönderme Kilidini Açma
description: Hesabın kullanım kotası bittiğinde ChatGPT masaüstü uygulamasının yazma alanını kullanılabilir tutar (macOS, isteğe bağlı).
---

Oturum açılmış ChatGPT hesabının kullanım kotası bittiğinde ChatGPT masaüstü uygulaması gönder
düğmesini devre dışı bırakır; opencodex'in model çağrılarını başka sağlayıcılara yönlendirdiği
konuşmalarda bile. Bu isteğe bağlı macOS entegrasyonu yazma alanını kullanılabilir tutar. Varsayılan
olarak kapalıdır.

## Neyi değiştirir

opencodex, `chatgpt.com` için yerel bir TLS dinleyicisi çalıştırır. Uygulama, `chatgpt.com`'u bu
dinleyiciye yönlendiren bir Chromium anahtarıyla başlatılır; alt alan adları dahil diğer tüm ana
bilgisayarlar normal yollarını korur. İstekler uygulamanın kendi kimlik bilgileriyle gerçek
`chatgpt.com`'a aktarılır; WebSocket bağlantıları (sesli dikte gibi) da aktarılır. Hiçbir şey
kaydedilmez veya saklanmaz.

Yanıtlar iki uç nokta dışında değiştirilmeden geçer:

- konuşma meta verileri (`/backend-api/conversation/init` ve konuşma akışı): kullanım kotasından
  kaynaklanan gönderme kilitleri kaldırılır;
- kullanım anlık görüntüsü (`/backend-api/wham/usage`): "sınıra ulaşıldı" geçidi açılır.

Abonelik gerekmesi gibi başka nedenli gönderme kilitleri korunur ve `ocx chatgpt status` tarafından
listelenir. Gösterilen kullanım (yüzdeler, sıfırlanma zamanları, afişler) hiçbir zaman değiştirilmez
ve OpenAI sunucuları kendi isteklerinde tüm sınırları uygulamaya devam eder.

Bazı sürümlerde gönder düğmesi, uygulamanın yerleşik Codex sunucusunun hesabınız hakkında
bildirdiklerini izler; bu sunucu bilgiyi kendi HTTP istemcisiyle alır ve ne çözümleyici kuralı ne de
bir PAC dosyası ona ulaşır. Bu durumu aşağıda anlatılan deneysel app-server ara katmanı karşılar.

## Kurulum

1. Özelliği `~/.opencodex/config.json` içinde açın ve opencodex'i yeniden başlatın:

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   Dinleyici, proxy bağlantı noktasının 200 fazlasını kullanır (varsayılan `10300`). Başka bir bağlantı
   noktası seçmek için `chatgptDesktop.port` ayarını yapın.

2. Yerel sertifika yetkilisine bir kez güvenin. Komut oturum açma parolanızı ister; bu yüzden kendiniz
   çalıştırın:

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   Bu güven olmadan uygulama hesap, kullanım ve ayarlar sayfalarını yükleyemez. Özel bir opencodex
   dizini kullanıyorsanız `ocx chatgpt status`, kurulumunuza uygun tam komutu yazdırır.

3. Uygulamayı opencodex üzerinden başlatın:

   ```bash
   ocx chatgpt launch
   ```

4. İsteğe bağlı: Dock ve Spotlight'tan yapılan normal başlatmaların da yolu kullanmasını sağlayın:

   ```bash
   ocx chatgpt install-watcher
   ```

   İzleyici, uygulama her başladığında ve opencodex başladığında da çalışır. Uygulama normal şekilde
   açıldıysa, başlatmanın hemen ardından uygulamayı kapatır ve yolla yeniden açar. Oturum açılışında
   uygulama opencodex'ten önce açılırsa, bunu opencodex çalışır çalışmaz yapar. Bir süredir
   kullandığınız uygulamayı kapatmamak için yalnızca son beş dakika içinde başlamış bir uygulamayı
   yeniden başlatır (çalışma süresi okunamazsa uygulama yeni başlamış sayılır); `ocx chatgpt launch`
   ise süreye bakmadan yeniden başlatır. opencodex çalışmıyorken hiçbir şey yapmaz. Komut onay ister;
   `--yes` etkileşimsiz onay verir.

## Ağ kurulumları

VPN veya proxy kuralı gerekmez. Varsayılan modda başlatma bağımsız değişkenleri, uygulama her
başladığında sistem proxy'sine göre seçilir:

| Kurulum | Uygulamanın başlatıldığı bağımsız değişkenler |
|---|---|
| Proxy yok | Yalnızca `chatgpt.com` yolu. |
| Sistem proxy modunda VPN | Yol, doğrudan bağlantı yedeği olan sistem proxy'si ve yalnızca `chatgpt.com` için atlama. |
| TUN modunda VPN | Yalnızca yol; geri döngü trafiği tünele hiç girmez. |
| PAC dosyası | Yalnızca yol. PAC dosyası `chatgpt.com`'u proxy'de tutabilir, bu yüzden yazma alanı kilitli kalabilir, ancak başka hiçbir şey bozulmaz. |

opencodex, diğer tüm giden trafiği gibi, gerçek `chatgpt.com`'a kendi `proxy` ayarı üzerinden ulaşır.

## opencodex durduğunda uygulamayı çalışır tutma

Varsayılan modda yönlendirilmiş bir uygulama dinleyiciye bağlıdır: opencodex durduğu sürece
`chatgpt.com` istekleri başarısız olur. PAC yedeği bunun yerine uygulamayı oluşturulan bir PAC
dosyasıyla başlatır; böylece uygulama kendiliğinden yedek yola geçer:

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` yalnızca `unblockSend` ile birlikte etkilidir. Bu durumda opencodex dinleyici portunun
bir fazlasını da (varsayılan `10301`) dinler ve her başlangıçta ana dizinindeki `chatgpt-unblock.pac`
dosyasını yeniden yazar. PAC, `chatgpt.com`'u önce opencodex'e, diğer tüm sunucuları ise sistemin
yönlendirdiği şekilde gönderir:

| Kurulum | Diğer sunucular ve opencodex durmuşken `chatgpt.com` |
|---|---|
| Proxy yok ya da TUN modunda VPN | Doğrudan. |
| Sistem proxy modunda VPN | Sistem proxy'si, ardından doğrudan. |
| PAC dosyası | Oluşturulan dosyaya gömülü sistem PAC'i. |

opencodex durduğunda uygulama yeniden başlatılmadan bu yoldan çalışmaya devam eder; yalnızca gönderme
kilidinin kaldırılması opencodex geri gelene kadar durur. Yol, opencodex başlarken alınır: VPN modunu
değiştirdikten sonra opencodex'i yeniden başlatın ve `ocx chatgpt launch` çalıştırın. O anda bir
sistem PAC'i ayarlı olduğu hâlde okunamıyorsa ya da uygulamaya aktarılamayacak kadar büyükse (PAC tek
bir başlatma argümanı içinde taşınır ve kodlandıktan sonra 512 KiB ile sınırlıdır), diğer sunucular
varsa sistem proxy'sinden, ardından doğrudan gider ve opencodex bir uyarı yazdırır.

`pacFallback`'i açıp kapattıktan sonra opencodex'i yeniden başlatın, `ocx chatgpt launch` çalıştırın
ve izleyiciyi kullanıyorsanız `ocx chatgpt install-watcher` komutunu yeniden çalıştırın.

## App-server ara katmanı (deneysel)

Ara katman, yerleşik Codex sunucusunun JSON-RPC çıktısını süzer ve bilinen basit kota kilitlerini
açar. Hesabın kotasını artırmaz ve yukarı akıştaki bir hizmete reddettiği bir isteği kabul ettirmez.
Yalnızca macOS'ta çalışır, varsayılan olarak kapalıdır ve iki şekilde kullanılır:

- **Tek başına.** `{ "chatgptDesktop": { "appServerShim": true } }` ayarlayın ve `ocx chatgpt launch`
  çalıştırın. opencodex kendi dizinine çalıştırılabilir bir başlatıcı yazar, ChatGPT çalışıyorsa
  kapatır ve `open -a <bundle> --env CODEX_CLI_PATH=<launcher>` ile yeniden başlatır. Uygulama paket
  kimliği `com.openai.codex` ile bulunur; bu nedenle `~/Applications` içinde veya başka bir birimde
  kurulum da çalışır ve aynı "ChatGPT" adını taşıyan başka bir uygulama asla kapatılmaz ya da
  açılmaz. Önce çalışmanızı kaydedin: uygulama yeniden başlar. Çalışan bir opencodex proxy'si
  gerekmez. Dock veya Spotlight'tan normal başlatmalar ara katmanı uygulamaz. `ocx chatgpt restore`
  başlatıcıyı siler ve uygulamayı değişken olmadan yeniden başlatır.
- **Gönderme kilidinin kaldırılmasıyla birlikte.** `unblockSend` ve `appServerShim` ikisi de açıkken
  opencodex başlatıcıyı her başlangıçta hazırlar; `ocx chatgpt launch` ve watcher uygulamayı onun
  üzerinden başlatır. Aşağıdaki denetimler paketi reddederse opencodex bir uyarı yazdırır ve yakalama
  ara katman olmadan çalışmaya devam eder.

Yalnızca `account/rateLimits/updated` bildirimleri ve üst düzey sonucu `rateLimits`,
`rateLimitsByLimitId` veya `ordinaryUsageAllowed` içeren yanıtlar ele alınır. Basit kotanın
`rate_limit_reached` işaretleri silinir; kilit bayrakları (`allowed`, `limit_reached` /
`limitReached`, `ordinaryUsageAllowed`) yalnızca basit kota kanıtı olduğunda açılır: bu işaret ya da
%100'e ulaşmış bir pencere. Yanıtın göstermediği bir nedenle kapalı olan bayrak kapalı kalır; çalışma
alanı, kredi, bilinmeyen ve harcama denetimi kısıtlamaları da kilidi kapalı tutar. Gösterilen
kullanım alındığı gibi kalır ve diğer tüm mesajlar bayt bayt geçer. Standart girdi, standart hata ve
gerçek ikili dosyanın çıkış kodu uygulamayla doğrudan bağlı kalır.

opencodex başlatıcıyı yazmadan önce paketin ve app-server ikili dosyasının size veya root'a ait
olduğunu, grup ya da diğerleri tarafından yazılamadığını ve OpenAI'nin ekip kimliğiyle (`2DC432GLL2`)
sıkı kod imzası doğrulamasından geçtiğini denetler. Bunlardan birinde başarısız olan paket
reddedilir. Başlatıcının kipi `0755`'tir, geçerli opencodex yürütülebilir dosyasını içerir ve önce
geçici bir dosyaya yazılıp yeniden adlandırılarak yerine konur; bu yoldaki bir sembolik bağlantı
izlenmez, değiştirilir. Başlatıcıyı, dizinini ve opencodex kurulumunu kendi denetiminizde tutun: bu
yolları değiştirmek uygulamanın çalıştırdığı kodu değiştirir.

Platform macOS değilse, opencodex çalışma ortamı eksikse veya süzgecin kendi testi başarısız olursa,
başlatıcı özgün ikili dosyayı çıktısına dokunmadan çalıştırır. Bir uygulama güncellemesi app-server
ikili dosyasının kendisini taşır veya silerse, başlatıcı `ocx chatgpt launch` ve
`ocx chatgpt restore` komutlarını anan bir mesaj yazdırıp çıkar ve bunlardan birini çalıştırana kadar
uygulama sunucusunu başlatamaz. Kendi testinden geçip oturum ortasında duran bir süzgeç sunucunun
çıktı borusunu kapatır; uygulamanın bundan sonra ne yaptığı doğrulanmamıştır. 8 MiB'tan uzun tek bir
çıktı satırı ayrıştırılmadan geçirilir. Ara katman, uygulamanın `CODEX_CLI_PATH`'e uymasına ve
güncellemelerle değişebilecek mevcut mesaj biçimlerine bağlıdır.

## Durumu kontrol etme

```bash
ocx chatgpt status
```

Özelliğin açık olup olmadığını, bağlantı noktasındaki dinleyicinin opencodex'e ait olup olmadığını,
sertifikanın güvenilir olup olmadığını, izleyici durumunu, çalışan uygulamanın yolu taşıyıp
taşımadığını ve bilerek korunan gönderme kilitlerini bildirir. App-server ara katmanı açıkken
başlatıcının var olup olmadığını ve çalışan uygulamanın onun üzerinden başlatılıp başlatılmadığını da
gösterir.

## Kapatma

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore`, yönlendirilmiş bir uygulamayı yerel ağ ile yeniden açar. Ardından
`chatgptDesktop.unblockSend` değerini `false` yapın ve opencodex'i yeniden başlatın. Sertifika
yetkilisi opencodex'in Claude entegrasyonlarıyla paylaşılır; güvenini yalnızca ikisini de
kullanmıyorsanız kaldırın. `restore` uygulamayı app-server ara katmanı olmadan da yeniden başlatır ve
başlatıcısını siler; `appServerShim` değerini de `false` yapın.

## Sorun giderme

- **Hesap, kullanım veya ayarlar sayfaları yüklenmiyor:** sertifika güvenilir değil. 2. adımı tekrar
  çalıştırın; `ocx chatgpt status` güven durumunu gösterir.
- **Gönder düğmesi hâlâ gri:** `ocx chatgpt status` çıktısına bakın. Uygulama yol olmadan çalışıyor
  olabilir (`ocx chatgpt launch` çalıştırın) ya da kilidin nedeni kullanım kotası değildir ve
  "send blocks kept" altında listelenir.
- **Yol çalıştığı hâlde gönder düğmesi gri kalıyor:** kilit, yolun kapsadığı sayfalardan değil
  yerleşik Codex sunucusundan geliyor olabilir. `chatgptDesktop.appServerShim` değerini açın,
  `ocx chatgpt launch` çalıştırın ve `ocx chatgpt status` çıktısına bakın ("app-server shim" satırı,
  çalışan uygulamanın ara katman üzerinden başlatılıp başlatılmadığını gösterir). opencodex
  başlangıçta ara katmanın hazırlanmadığı konusunda uyardıysa veya `launch` onu reddediyorsa, mesaj
  paketin geçemediği denetimi belirtir.
- **opencodex durduktan sonra uygulama hiçbir şey yükleyemiyor:** varsayılan modda yönlendirilmiş bir
  uygulama dinleyiciye bağlıdır. opencodex'i yeniden başlatın ya da `ocx chatgpt restore` çalıştırın;
  PAC yedeğini açarsanız uygulama kendiliğinden yedek yola geçer.
