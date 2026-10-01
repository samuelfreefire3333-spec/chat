package main

import (
	"log/slog"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// ==========================================================================
// Limite de taxa por chave (IP, uid, "uid|tipo")
// ==========================================================================
// O balde de fichas é o golang.org/x/time/rate, mantido pelo time do Go. Aqui
// só existe o mapa de baldes por chave e a faxina dos que ficaram parados.

type baldeComUso struct {
	limitador *rate.Limiter
	usadoEm   time.Time
}

// LimitadorPorChave aplica "N por minuto, com rajada R" separadamente para
// cada chave. Seguro para uso concorrente.
type LimitadorPorChave struct {
	mu              sync.Mutex
	limite          rate.Limit
	rajada          int
	baldes          map[string]*baldeComUso
	maxChaves       int
	agora           func() time.Time
	ultimaFaxina    time.Time
	tempoParaEncher time.Duration
}

// NovoLimitadorPorChave cria um limitador de porMinuto eventos por minuto,
// aceitando até rajada eventos seguidos.
func NovoLimitadorPorChave(porMinuto float64, rajada int) *LimitadorPorChave {
	limite := rate.Limit(porMinuto / 60)
	encher := time.Minute
	if porMinuto > 0 {
		encher = time.Duration(float64(rajada) / float64(limite) * float64(time.Second))
	}
	return &LimitadorPorChave{
		limite:          limite,
		rajada:          rajada,
		baldes:          make(map[string]*baldeComUso),
		maxChaves:       200000,
		agora:           time.Now,
		tempoParaEncher: encher,
	}
}

// Permitir consome uma ficha da chave, se houver.
func (l *LimitadorPorChave) Permitir(chave string) bool {
	return l.PermitirN(chave, 1)
}

// PermitirN consome n fichas de uma vez (ou nenhuma, se não houver n).
func (l *LimitadorPorChave) PermitirN(chave string, n int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	agora := l.agora()
	if agora.Sub(l.ultimaFaxina) > time.Minute {
		l.faxinaLocked(agora)
	}

	b := l.baldes[chave]
	if b == nil {
		if len(l.baldes) >= l.maxChaves {
			l.faxinaLocked(agora)
			if len(l.baldes) >= l.maxChaves {
				// Só acontece sob ataque com centenas de milhares de chaves:
				// recomeçar do zero é melhor do que crescer sem limite.
				slog.Warn("limitador cheio, reiniciando", "chaves", len(l.baldes))
				l.baldes = make(map[string]*baldeComUso)
			}
		}
		b = &baldeComUso{limitador: rate.NewLimiter(l.limite, l.rajada)}
		l.baldes[chave] = b
	}
	b.usadoEm = agora
	return b.limitador.AllowN(agora, n)
}

// faxinaLocked remove baldes parados há tempo suficiente para estarem cheios
// de novo — apagá-los não muda o comportamento.
func (l *LimitadorPorChave) faxinaLocked(agora time.Time) {
	l.ultimaFaxina = agora
	for chave, b := range l.baldes {
		if agora.Sub(b.usadoEm) > l.tempoParaEncher {
			delete(l.baldes, chave)
		}
	}
}

// ==========================================================================
// Bloqueio temporário depois de falhas repetidas (ex.: tokens inválidos)
// ==========================================================================

type registroDeFalhas struct {
	inicio       time.Time
	quantas      int
	bloqueadoAte time.Time
}

// ContadorDeFalhas bloqueia uma chave por um tempo depois de "limite" falhas
// dentro de "janela". Não zera no sucesso: atrás de um NAT, o sucesso de uma
// pessoa não pode apagar as tentativas de outra.
type ContadorDeFalhas struct {
	mu       sync.Mutex
	janela   time.Duration
	limite   int
	bloqueio time.Duration
	itens    map[string]*registroDeFalhas
	agora    func() time.Time
}

func NovoContadorDeFalhas(limite int, janela, bloqueio time.Duration) *ContadorDeFalhas {
	return &ContadorDeFalhas{
		janela:   janela,
		limite:   limite,
		bloqueio: bloqueio,
		itens:    make(map[string]*registroDeFalhas),
		agora:    time.Now,
	}
}

// Registrar anota uma falha e diz se a chave acabou de ficar (ou já estava)
// bloqueada.
func (c *ContadorDeFalhas) Registrar(chave string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	agora := c.agora()
	if len(c.itens) > 100000 {
		c.faxinaLocked(agora)
	}
	r := c.itens[chave]
	if r == nil || agora.Sub(r.inicio) > c.janela {
		r = &registroDeFalhas{inicio: agora}
		c.itens[chave] = r
	}
	r.quantas++
	if r.quantas >= c.limite {
		r.bloqueadoAte = agora.Add(c.bloqueio)
	}
	return agora.Before(r.bloqueadoAte)
}

// Bloqueado diz se a chave está no castigo agora.
func (c *ContadorDeFalhas) Bloqueado(chave string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	r := c.itens[chave]
	return r != nil && c.agora().Before(r.bloqueadoAte)
}

func (c *ContadorDeFalhas) faxinaLocked(agora time.Time) {
	for chave, r := range c.itens {
		if agora.Sub(r.inicio) > c.janela && !agora.Before(r.bloqueadoAte) {
			delete(c.itens, chave)
		}
	}
}

// ==========================================================================
// Conexões simultâneas (total e por IP)
// ==========================================================================

type ContadorDeConexoes struct {
	mu       sync.Mutex
	total    int
	porIP    map[string]int
	maxTotal int
	maxPorIP int
}

func NovoContadorDeConexoes(maxTotal, maxPorIP int) *ContadorDeConexoes {
	return &ContadorDeConexoes{porIP: make(map[string]int), maxTotal: maxTotal, maxPorIP: maxPorIP}
}

// Reservar ocupa uma vaga para o IP. Quem recebe true precisa chamar Liberar.
func (c *ContadorDeConexoes) Reservar(ip string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.total >= c.maxTotal || c.porIP[ip] >= c.maxPorIP {
		return false
	}
	c.total++
	c.porIP[ip]++
	return true
}

func (c *ContadorDeConexoes) Liberar(ip string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.porIP[ip] > 0 {
		c.porIP[ip]--
		c.total--
	}
	if c.porIP[ip] == 0 {
		delete(c.porIP, ip)
	}
}

// Ativas devolve o total de conexões abertas agora.
func (c *ContadorDeConexoes) Ativas() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total
}
