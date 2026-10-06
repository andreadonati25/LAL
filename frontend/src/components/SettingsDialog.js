import { useState, useEffect } from "react";
import api, { formatApiError } from "@/lib/api";
import { SETTINGS } from "@/constants/testIds";
import { useAuth } from "@/context/AuthContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

/* Componente SettingsDialog: permette all'utente di cambiare la propria password
   e/o modificare i propri dati anagrafici (nome, email). Due form indipendenti. */

export default function SettingsDialog({ open, onOpenChange }) {
  const { user, bootstrap } = useAuth();
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loadingPass, setLoadingPass] = useState(false);
  const [loadingData, setLoadingData] = useState(false);

  /* Ad ogni apertura: pulisce i campi password e ripopola nome/email con i dati correnti dell'utente */
  useEffect(() => {
    if (open) {
      setOldPw(""); setNewPw(""); setConfirm("");
      setName(user?.name || "");
      setEmail(user?.email || "");
    }
  }, [open, user]);

  const submitPass = async (e) => {
    e.preventDefault();
    if (newPw.length < 6) return toast.error("Almeno 6 caratteri");
    if (newPw !== confirm) return toast.error("Le password non coincidono");
    setLoadingPass(true);
    try {
      await api.post("/auth/change-password", { old_password: oldPw, new_password: newPw });
      toast.success("Password aggiornata");
      await bootstrap();
      setOldPw(""); setNewPw(""); setConfirm("");
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setLoadingPass(false); }
  };

  const submitData = async (e) => {
    e.preventDefault();
    if (name === user?.name && email === user?.email) {
      toast.info("Nessuna modifica da salvare");
      return;
    }
    setLoadingData(true);
    try {
      await api.patch(`/users/${user.id}`, { name, email });
      toast.success("Dati aggiornati");
      await bootstrap();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setLoadingData(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={SETTINGS.dialog}
        className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-2xl max-h-[90vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>Impostazioni</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
          <form onSubmit={submitPass} className="space-y-4">
            <div className="text-[10px] uppercase tracking-widest text-[color:var(--gold)] font-bold">
              Cambia password
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Password attuale</label>
              <Input type="password" required value={oldPw} onChange={(e) => setOldPw(e.target.value)} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Nuova password</label>
              <Input data-testid={SETTINGS.newPasswordInput} type="password" required minLength={6} value={newPw} onChange={(e) => setNewPw(e.target.value)} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Conferma nuova password</label>
              <Input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
            </div>
            <DialogFooter>
              <Button data-testid={SETTINGS.changePasswordSubmit} type="submit" disabled={loadingPass}
                className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">
                {loadingPass ? "Salvo…" : "Salva password"}
              </Button>
            </DialogFooter>
          </form>

          <form onSubmit={submitData} className="space-y-4 pt-6 border-t border-[color:var(--border)] md:pt-0 md:border-t-0 md:pl-8 md:border-l">
            <div className="text-[10px] uppercase tracking-widest text-[color:var(--gold)] font-bold">
              Modifica dati
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Nome</label>
              <Input type="text" required value={name} onChange={(e) => setName(e.target.value)} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Email</label>
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
            </div>
            <DialogFooter>
              <Button data-testid={SETTINGS.changeDataSubmit} type="submit" disabled={loadingData}
                className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">
                {loadingData ? "Modifico…" : "Modifica dati"}
              </Button>
            </DialogFooter>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}